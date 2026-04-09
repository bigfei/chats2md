import type { AccountHealthResult } from "../main/account-health";
import type { StoredSessionAccount } from "../shared/types";

export interface AllAccountsHealthPreflightContext {
  accounts: StoredSessionAccount[];
  ensureCanContinue(): Promise<boolean>;
  checkAccountHealth(account: StoredSessionAccount): Promise<AccountHealthResult>;
  updateAccountHealth(accountId: string, result: AccountHealthResult): Promise<StoredSessionAccount | null>;
  getAccountLabel(account: StoredSessionAccount): string;
  logSkip(message: string): void;
}

export interface AllAccountsHealthPreflightResult {
  status: "continue" | "stop" | "no-healthy-accounts";
  accounts: StoredSessionAccount[];
  skippedLabels: string[];
}

export async function runAllAccountsHealthPreflight(
  context: AllAccountsHealthPreflightContext,
): Promise<AllAccountsHealthPreflightResult> {
  const healthyAccounts: StoredSessionAccount[] = [];
  const skippedLabels: string[] = [];

  for (const account of context.accounts) {
    if (!(await context.ensureCanContinue())) {
      return {
        status: "stop",
        accounts: healthyAccounts,
        skippedLabels,
      };
    }

    const result = await context.checkAccountHealth(account);
    const updated = await context.updateAccountHealth(account.accountId, result);
    const effectiveAccount = updated ?? account;

    if (result.status === "disable-and-skip" || effectiveAccount.disabled) {
      const label = context.getAccountLabel(effectiveAccount);
      skippedLabels.push(label);
      context.logSkip(`[${label}] Skipping disabled account: ${result.message}`);
      continue;
    }

    healthyAccounts.push(effectiveAccount);
  }

  return {
    status: healthyAccounts.length > 0 ? "continue" : "no-healthy-accounts",
    accounts: healthyAccounts,
    skippedLabels,
  };
}
