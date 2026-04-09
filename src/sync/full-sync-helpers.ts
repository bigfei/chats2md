import type { AccountHealthResult } from "../main/account-health";
import type {
  ImportFailure,
  ImportProgressCounts,
  StoredSessionAccount,
  SyncReportConversationEntry,
} from "../shared/types";

export interface SyncRunState {
  counts: ImportProgressCounts;
  failures: ImportFailure[];
  createdEntries: SyncReportConversationEntry[];
  updatedEntries: SyncReportConversationEntry[];
  movedEntries: SyncReportConversationEntry[];
  failedEntries: SyncReportConversationEntry[];
  discoveredConversations: number;
  processedConversations: number;
  totalConversations: number;
}

export interface HealthyAccountFilterResult {
  healthyAccounts: StoredSessionAccount[];
  skippedLabels: string[];
}

export function createSyncRunState(counts: ImportProgressCounts): SyncRunState {
  return {
    counts,
    failures: [],
    createdEntries: [],
    updatedEntries: [],
    movedEntries: [],
    failedEntries: [],
    discoveredConversations: 0,
    processedConversations: 0,
    totalConversations: 0,
  };
}

export function recordSyncFailure(
  state: SyncRunState,
  failure: ImportFailure,
  reportEntry?: SyncReportConversationEntry,
): void {
  state.counts.failed += 1;
  state.failures.push(failure);

  if (reportEntry) {
    state.failedEntries.push(reportEntry);
  }
}

export async function filterHealthyAccountsForAllScope(
  accounts: StoredSessionAccount[],
  allConfiguredAccounts: StoredSessionAccount[],
  dependencies: {
    ensureCanContinue: () => Promise<boolean>;
    checkAccountHealth: (account: StoredSessionAccount) => Promise<AccountHealthResult>;
    getAccountLabel: (account: StoredSessionAccount) => string;
    onUnhealthyAccount: (account: StoredSessionAccount, result: AccountHealthResult) => void;
  },
): Promise<HealthyAccountFilterResult | null> {
  const skippedLabels = allConfiguredAccounts
    .filter((account) => account.disabled)
    .map((account) => dependencies.getAccountLabel(account));
  const healthyAccounts: StoredSessionAccount[] = [];

  for (const account of accounts) {
    if (!(await dependencies.ensureCanContinue())) {
      return null;
    }

    const result = await dependencies.checkAccountHealth(account);
    if (result.status === "healthy") {
      healthyAccounts.push(account);
      continue;
    }

    skippedLabels.push(dependencies.getAccountLabel(account));
    dependencies.onUnhealthyAccount(account, result);
  }

  return {
    healthyAccounts,
    skippedLabels,
  };
}
