import { checkRequestConfigHealth, type AccountHealthResult } from "../main/account-health";
import { getStoredAccountDisplayName } from "../main/helpers";
import { CUSTOM_TEMPLATE_OPTION, buildSyncReportCleanupNotice, summarizeAccountHealthResults } from "./settings-helpers";

import type { ChatGptRequestConfig, StoredSessionAccount } from "../shared/types";

export async function applyConversationTemplatePresetSelection(
  value: string,
  dependencies: {
    setConversationPathTemplate: (value: string) => void;
    saveSettings: () => Promise<void>;
    notice: (message: string) => void;
    rerender: () => void;
  },
): Promise<void> {
  if (value === CUSTOM_TEMPLATE_OPTION) {
    return;
  }

  dependencies.setConversationPathTemplate(value);
  await dependencies.saveSettings();
  dependencies.notice(`Applied conversation template: ${value}`);
  dependencies.rerender();
}

export async function runSyncReportCleanupAction(
  dependencies: {
    confirm: (message: string) => boolean;
    cleanupSyncReports: (options?: { keepLatest: number }) => Promise<{ removedPaths: string[]; keptPaths: string[] }>;
    keepLatest?: number;
    notice: (message: string) => void;
    setDisabled: (disabled: boolean) => void;
  },
): Promise<void> {
  const confirmationMessage =
    dependencies.keepLatest === undefined
      ? "Delete all generated sync report and sync log files from the configured report folder?"
      : "Delete older generated sync reports/logs and keep only the latest 10 files?";

  if (!dependencies.confirm(confirmationMessage)) {
    return;
  }

  dependencies.setDisabled(true);
  try {
    const result =
      dependencies.keepLatest === undefined
        ? await dependencies.cleanupSyncReports()
        : await dependencies.cleanupSyncReports({ keepLatest: dependencies.keepLatest });
    dependencies.notice(buildSyncReportCleanupNotice(result, dependencies.keepLatest));
  } finally {
    dependencies.setDisabled(false);
  }
}

export async function runDeleteAccountSessionAction(
  account: StoredSessionAccount,
  dependencies: {
    confirm: (message: string) => boolean;
    removeSessionAccount: (accountId: string) => Promise<void>;
    clearTransientHealthResult: (accountId: string) => void;
    notice: (message: string) => void;
    rerender: () => void;
  },
): Promise<void> {
  const label = getStoredAccountDisplayName(account);
  if (!dependencies.confirm(`Delete account session for ${label}?`)) {
    return;
  }

  await dependencies.removeSessionAccount(account.accountId);
  dependencies.clearTransientHealthResult(account.accountId);
  dependencies.notice(`Deleted account session for ${label}.`);
  dependencies.rerender();
}

export async function runCheckAllAccountsAction(
  accounts: StoredSessionAccount[],
  dependencies: {
    checkAccountHealth: (account: StoredSessionAccount) => Promise<AccountHealthResult>;
    setTransientHealthResult: (accountId: string, result: AccountHealthResult) => void;
    notice: (message: string) => void;
    rerender: () => void;
  },
): Promise<void> {
  if (accounts.length === 0) {
    dependencies.notice("No account sessions configured.");
    return;
  }

  const results: AccountHealthResult[] = [];
  for (const account of accounts) {
    const result = await dependencies.checkAccountHealth(account);
    dependencies.setTransientHealthResult(account.accountId, result);
    results.push(result);
  }

  dependencies.notice(summarizeAccountHealthResults(results).notice);
  dependencies.rerender();
}

export async function runCheckAccountAction(
  account: StoredSessionAccount,
  dependencies: {
    checkAccountHealth: (account: StoredSessionAccount) => Promise<AccountHealthResult>;
    setTransientHealthResult: (accountId: string, result: AccountHealthResult) => void;
    notice: (message: string) => void;
    rerender: () => void;
    logError: (message: string, context: Record<string, unknown>) => void;
  },
): Promise<void> {
  const label = getStoredAccountDisplayName(account);
  const result = await dependencies.checkAccountHealth(account);
  dependencies.setTransientHealthResult(account.accountId, result);

  if (result.status === "healthy") {
    dependencies.notice(`Account is healthy for ${label}.`);
  } else {
    dependencies.notice(`Health check warning for ${label}: ${result.message}`);
    dependencies.logError("Account health check issue", {
      accountId: account.accountId,
      status: result.status,
      message: result.message,
    });
  }

  dependencies.rerender();
}

export async function runSaveSessionAction(
  raw: string,
  parsed: ChatGptRequestConfig,
  dependencies: {
    checkRequestConfigHealth?: typeof checkRequestConfigHealth;
    upsertSessionAccount: (raw: string, parsed: ChatGptRequestConfig) => Promise<StoredSessionAccount>;
    clearTransientHealthResult: (accountId: string) => void;
    notice: (message: string) => void;
    rerender: () => void;
  },
): Promise<void> {
  const healthCheck = dependencies.checkRequestConfigHealth ?? checkRequestConfigHealth;
  const result = await healthCheck(parsed);

  if (result.status !== "healthy") {
    throw new Error(result.message);
  }

  const saved = await dependencies.upsertSessionAccount(raw, parsed);
  dependencies.clearTransientHealthResult(saved.accountId);
  dependencies.notice(`Saved session for ${getStoredAccountDisplayName(saved)}.`);
  dependencies.rerender();
}
