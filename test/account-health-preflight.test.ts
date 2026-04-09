import assert from "node:assert/strict";
import test from "node:test";

import { runAllAccountsHealthPreflight } from "../src/sync/account-health-preflight.ts";
import type { AccountHealthResult } from "../src/main/account-health.ts";
import type { StoredSessionAccount } from "../src/shared/types.ts";

function createAccount(accountId: string, overrides: Partial<StoredSessionAccount> = {}): StoredSessionAccount {
  return {
    accountId,
    userId: `${accountId}-user`,
    email: `${accountId}@example.com`,
    secretId: `${accountId}-secret`,
    disabled: false,
    addedAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function createResult(status: AccountHealthResult["status"], message: string): AccountHealthResult {
  return {
    status,
    checkedAt: "2026-04-09T00:00:00.000Z",
    message,
  };
}

test("runAllAccountsHealthPreflight skips newly invalid accounts and keeps healthy ones", async () => {
  const accounts = [createAccount("acc-1"), createAccount("acc-2")];
  const updatedAccounts = new Map<string, StoredSessionAccount>([
    ["acc-1", createAccount("acc-1", { disabled: true })],
    ["acc-2", createAccount("acc-2", { disabled: false })],
  ]);
  const logMessages: string[] = [];

  const result = await runAllAccountsHealthPreflight({
    accounts,
    ensureCanContinue: async () => true,
    checkAccountHealth: async (account) =>
      account.accountId === "acc-1"
        ? createResult("disable-and-skip", "expired")
        : createResult("healthy", "ok"),
    updateAccountHealth: async (accountId) => updatedAccounts.get(accountId) ?? null,
    getAccountLabel: (account) => account.email,
    logSkip: (message) => logMessages.push(message),
  });

  assert.equal(result.status, "continue");
  assert.deepEqual(result.accounts.map((account) => account.accountId), ["acc-2"]);
  assert.deepEqual(result.skippedLabels, ["acc-1@example.com"]);
  assert.deepEqual(logMessages, ["[acc-1@example.com] Skipping disabled account: expired"]);
});

test("runAllAccountsHealthPreflight keeps transient accounts enabled when update keeps them enabled", async () => {
  const account = createAccount("acc-1");

  const result = await runAllAccountsHealthPreflight({
    accounts: [account],
    ensureCanContinue: async () => true,
    checkAccountHealth: async () => createResult("transient-keep-enabled", "network"),
    updateAccountHealth: async () => createAccount("acc-1", { disabled: false, lastHealthCheckError: "network" }),
    getAccountLabel: (current) => current.email,
    logSkip: () => {
      throw new Error("transient account should not be skipped");
    },
  });

  assert.equal(result.status, "continue");
  assert.deepEqual(result.accounts.map((current) => current.accountId), ["acc-1"]);
  assert.deepEqual(result.skippedLabels, []);
});

test("runAllAccountsHealthPreflight reports no healthy accounts when all accounts remain disabled", async () => {
  const account = createAccount("acc-1", { disabled: true });
  const logMessages: string[] = [];

  const result = await runAllAccountsHealthPreflight({
    accounts: [account],
    ensureCanContinue: async () => true,
    checkAccountHealth: async () => createResult("transient-keep-enabled", "network"),
    updateAccountHealth: async () => createAccount("acc-1", { disabled: true, lastHealthCheckError: "network" }),
    getAccountLabel: (current) => current.email,
    logSkip: (message) => logMessages.push(message),
  });

  assert.equal(result.status, "no-healthy-accounts");
  assert.deepEqual(result.accounts, []);
  assert.deepEqual(result.skippedLabels, ["acc-1@example.com"]);
  assert.deepEqual(logMessages, ["[acc-1@example.com] Skipping disabled account: network"]);
});

test("runAllAccountsHealthPreflight stops immediately when sync can no longer continue", async () => {
  let checked = 0;

  const result = await runAllAccountsHealthPreflight({
    accounts: [createAccount("acc-1"), createAccount("acc-2")],
    ensureCanContinue: async () => checked++ === 0,
    checkAccountHealth: async () => createResult("healthy", "ok"),
    updateAccountHealth: async (accountId) => createAccount(accountId),
    getAccountLabel: (account) => account.email,
    logSkip: () => undefined,
  });

  assert.equal(result.status, "stop");
  assert.deepEqual(result.accounts.map((account) => account.accountId), ["acc-1"]);
});
