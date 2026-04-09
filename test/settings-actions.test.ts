import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConversationTemplatePresetSelection,
  runCheckAccountAction,
  runCheckAllAccountsAction,
  runDeleteAccountSessionAction,
  runSaveSessionAction,
  runSyncReportCleanupAction,
} from "../src/ui/settings-actions.ts";

const account = {
  accountId: "acc-1",
  userId: "user-1",
  email: "user@example.com",
  secretId: "secret-1",
  disabled: false,
  addedAt: "2026-04-09T00:00:00.000Z",
  updatedAt: "2026-04-09T00:00:00.000Z",
};

test("applyConversationTemplatePresetSelection ignores customize and rerenders on preset changes", async () => {
  const notices: string[] = [];
  let currentTemplate = "{date}/{slug}";
  let renders = 0;
  let saves = 0;

  await applyConversationTemplatePresetSelection("__custom__", {
    setConversationPathTemplate: (value) => {
      currentTemplate = value;
    },
    saveSettings: async () => {
      saves += 1;
    },
    notice: (message) => notices.push(message),
    rerender: () => {
      renders += 1;
    },
  });

  await applyConversationTemplatePresetSelection("{email}/{date}/{slug}", {
    setConversationPathTemplate: (value) => {
      currentTemplate = value;
    },
    saveSettings: async () => {
      saves += 1;
    },
    notice: (message) => notices.push(message),
    rerender: () => {
      renders += 1;
    },
  });

  assert.equal(currentTemplate, "{email}/{date}/{slug}");
  assert.equal(saves, 1);
  assert.equal(renders, 1);
  assert.deepEqual(notices, ["Applied conversation template: {email}/{date}/{slug}"]);
});

test("runSyncReportCleanupAction respects confirmation and toggles button disabled state", async () => {
  const notices: string[] = [];
  const disabledStates: boolean[] = [];
  let cleanupCalls = 0;

  await runSyncReportCleanupAction({
    confirm: () => false,
    cleanupSyncReports: async () => {
      cleanupCalls += 1;
      return { removedPaths: [], keptPaths: [] };
    },
    notice: (message) => notices.push(message),
    setDisabled: (disabled) => disabledStates.push(disabled),
  });

  await runSyncReportCleanupAction({
    confirm: () => true,
    cleanupSyncReports: async (options) => {
      cleanupCalls += 1;
      assert.deepEqual(options, { keepLatest: 10 });
      return { removedPaths: ["a.md"], keptPaths: ["b.md"] };
    },
    keepLatest: 10,
    notice: (message) => notices.push(message),
    setDisabled: (disabled) => disabledStates.push(disabled),
  });

  assert.equal(cleanupCalls, 1);
  assert.deepEqual(disabledStates, [true, false]);
  assert.deepEqual(notices, ["Removed 1 sync report/log file(s). Kept 1."]);
});

test("runDeleteAccountSessionAction respects confirmation and rerenders after deletion", async () => {
  const notices: string[] = [];
  const clearedIds: string[] = [];
  const removedIds: string[] = [];
  let renders = 0;

  await runDeleteAccountSessionAction(account, {
    confirm: () => false,
    removeSessionAccount: async (accountId) => {
      removedIds.push(accountId);
    },
    clearTransientHealthResult: (accountId) => clearedIds.push(accountId),
    notice: (message) => notices.push(message),
    rerender: () => {
      renders += 1;
    },
  });

  await runDeleteAccountSessionAction(account, {
    confirm: () => true,
    removeSessionAccount: async (accountId) => {
      removedIds.push(accountId);
    },
    clearTransientHealthResult: (accountId) => clearedIds.push(accountId),
    notice: (message) => notices.push(message),
    rerender: () => {
      renders += 1;
    },
  });

  assert.deepEqual(removedIds, ["acc-1"]);
  assert.deepEqual(clearedIds, ["acc-1"]);
  assert.equal(renders, 1);
  assert.deepEqual(notices, ["Deleted account session for user@example.com."]);
});

test("runCheckAllAccountsAction reports empty state and summarizes results", async () => {
  const notices: string[] = [];
  const healthResults = new Map<string, { status: "healthy" | "disable-and-skip"; checkedAt: string; message: string }>();
  let renders = 0;

  await runCheckAllAccountsAction([], {
    checkAccountHealth: async () => {
      throw new Error("should not run");
    },
    setTransientHealthResult: () => undefined,
    notice: (message) => notices.push(message),
    rerender: () => {
      renders += 1;
    },
  });

  await runCheckAllAccountsAction([account, { ...account, accountId: "acc-2", email: "other@example.com" }], {
    checkAccountHealth: async (currentAccount) =>
      currentAccount.accountId === "acc-1"
        ? { status: "healthy" as const, checkedAt: "2026-04-09T00:00:00.000Z", message: "ok" }
        : { status: "disable-and-skip" as const, checkedAt: "2026-04-09T00:00:00.000Z", message: "expired" },
    setTransientHealthResult: (accountId, result) => {
      healthResults.set(accountId, result);
    },
    notice: (message) => notices.push(message),
    rerender: () => {
      renders += 1;
    },
  });

  assert.equal(healthResults.size, 2);
  assert.deepEqual(notices, ["No account sessions configured.", "Account health check complete. 1 healthy, 1 unhealthy."]);
  assert.equal(renders, 1);
});

test("runCheckAccountAction reports healthy and unhealthy results", async () => {
  const notices: string[] = [];
  const transientResults = new Map<string, unknown>();
  const loggedErrors: Array<{ message: string; context: Record<string, unknown> }> = [];
  let renders = 0;

  await runCheckAccountAction(account, {
    checkAccountHealth: async () => ({ status: "healthy" as const, checkedAt: "2026-04-09T00:00:00.000Z", message: "ok" }),
    setTransientHealthResult: (accountId, result) => transientResults.set(accountId, result),
    notice: (message) => notices.push(message),
    rerender: () => {
      renders += 1;
    },
    logError: (message, context) => loggedErrors.push({ message, context }),
  });

  await runCheckAccountAction(account, {
    checkAccountHealth: async () => ({
      status: "disable-and-skip" as const,
      checkedAt: "2026-04-09T00:00:00.000Z",
      message: "expired",
    }),
    setTransientHealthResult: (accountId, result) => transientResults.set(accountId, result),
    notice: (message) => notices.push(message),
    rerender: () => {
      renders += 1;
    },
    logError: (message, context) => loggedErrors.push({ message, context }),
  });

  assert.equal(transientResults.size, 1);
  assert.equal(renders, 2);
  assert.deepEqual(notices, [
    "Account is healthy for user@example.com.",
    "Health check warning for user@example.com: expired",
  ]);
  assert.deepEqual(loggedErrors, [
    {
      message: "Account health check issue",
      context: {
        accountId: "acc-1",
        status: "disable-and-skip",
        message: "expired",
      },
    },
  ]);
});

test("runSaveSessionAction validates, saves, clears health state, and rerenders", async () => {
  const notices: string[] = [];
  const clearedIds: string[] = [];
  let renders = 0;

  await runSaveSessionAction(
    "{\"accessToken\":\"token\"}",
    {
      accessToken: "token",
      accountId: "acc-1",
      userId: "user-1",
      userEmail: "user@example.com",
      headers: {},
      userAgent: "agent",
    },
    {
      checkRequestConfigHealth: async () => ({ status: "healthy", checkedAt: "2026-04-09T00:00:00.000Z", message: "ok" }),
      upsertSessionAccount: async () => account,
      clearTransientHealthResult: (accountId) => clearedIds.push(accountId),
      notice: (message) => notices.push(message),
      rerender: () => {
        renders += 1;
      },
    },
  );

  await assert.rejects(
    () =>
      runSaveSessionAction(
        "{\"accessToken\":\"token\"}",
        {
          accessToken: "token",
          accountId: "acc-1",
          userId: "user-1",
          userEmail: "user@example.com",
          headers: {},
          userAgent: "agent",
        },
        {
          checkRequestConfigHealth: async () => ({
            status: "disable-and-skip",
            checkedAt: "2026-04-09T00:00:00.000Z",
            message: "expired",
          }),
          upsertSessionAccount: async () => account,
          clearTransientHealthResult: () => undefined,
          notice: () => undefined,
          rerender: () => undefined,
        },
      ),
    /expired/,
  );

  assert.deepEqual(clearedIds, ["acc-1"]);
  assert.deepEqual(notices, ["Saved session for user@example.com."]);
  assert.equal(renders, 1);
});
