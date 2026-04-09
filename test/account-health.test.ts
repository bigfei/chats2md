import assert from "node:assert/strict";
import test from "node:test";

import { ChatGptRequestError } from "../src/chatgpt/request-core.ts";
import {
  applyAccountHealthResult,
  checkRequestConfigHealth,
  checkStoredAccountHealth,
} from "../src/main/account-health.ts";
import { ConsecutiveRateLimitPauseError } from "../src/sync/rate-limit-guard.ts";
import type { ChatGptRequestConfig, StoredSessionAccount } from "../src/shared/types.ts";

function createAccount(overrides: Partial<StoredSessionAccount> = {}): StoredSessionAccount {
  return {
    accountId: "acc-1",
    userId: "user-1",
    email: "user@example.com",
    expiresAt: "2026-12-31T00:00:00.000Z",
    secretId: "secret-1",
    disabled: false,
    addedAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function createRequestConfig(overrides: Partial<ChatGptRequestConfig> = {}): ChatGptRequestConfig {
  return {
    accessToken: "token",
    accountId: "acc-1",
    userId: "user-1",
    userEmail: "user@example.com",
    headers: {},
    userAgent: "ua",
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...overrides,
  };
}

test("applyAccountHealthResult disables definite failures", () => {
  const updated = applyAccountHealthResult(createAccount(), {
    status: "disable-and-skip",
    checkedAt: "2026-04-09T00:00:00.000Z",
    message: "expired",
  });

  assert.equal(updated.disabled, true);
  assert.equal(updated.lastHealthCheckError, "expired");
});

test("applyAccountHealthResult re-enables healthy accounts", () => {
  const updated = applyAccountHealthResult(
    createAccount({
      disabled: true,
      lastHealthCheckError: "expired",
    }),
    {
      status: "healthy",
      checkedAt: "2026-04-09T00:00:00.000Z",
      message: "ok",
      requestConfig: createRequestConfig(),
    },
  );

  assert.equal(updated.disabled, false);
  assert.equal(updated.lastHealthCheckError, undefined);
});

test("applyAccountHealthResult preserves disabled state for transient failures", () => {
  const updated = applyAccountHealthResult(
    createAccount({
      disabled: true,
      lastHealthCheckError: "expired",
    }),
    {
      status: "transient-keep-enabled",
      checkedAt: "2026-04-09T00:00:00.000Z",
      message: "network",
    },
  );

  assert.equal(updated.disabled, true);
  assert.equal(updated.lastHealthCheckError, "network");
});

test("checkStoredAccountHealth disables missing secrets", async () => {
  const result = await checkStoredAccountHealth(
    {
      getSessionSecret: () => null,
      manifestVersion: "1.0.0",
    },
    createAccount(),
    {
      createCheckedAt: () => "2026-04-09T00:00:00.000Z",
    },
  );

  assert.equal(result.status, "disable-and-skip");
  assert.equal(result.checkedAt, "2026-04-09T00:00:00.000Z");
  assert.match(result.message, /Missing session secret/);
});

test("checkStoredAccountHealth disables invalid session JSON", async () => {
  const result = await checkStoredAccountHealth(
    {
      getSessionSecret: () => "{bad json",
      manifestVersion: "1.0.0",
    },
    createAccount(),
    {
      createCheckedAt: () => "2026-04-09T00:00:00.000Z",
    },
  );

  assert.equal(result.status, "disable-and-skip");
  assert.match(result.message, /Invalid session JSON/);
});

test("checkStoredAccountHealth disables stored-account mismatches by account identity", async () => {
  const result = await checkStoredAccountHealth(
    {
      getSessionSecret: () => "unused",
      manifestVersion: "1.0.0",
    },
    createAccount(),
    {
      createCheckedAt: () => "2026-04-09T00:00:00.000Z",
      parseSessionJson: () =>
        createRequestConfig({
          accountId: "acc-2",
        }),
    },
  );

  assert.equal(result.status, "disable-and-skip");
  assert.match(result.message, /Stored account mismatch/);
});

test("checkStoredAccountHealth disables expired sessions from stored metadata", async () => {
  const result = await checkStoredAccountHealth(
    {
      getSessionSecret: () => "unused",
      manifestVersion: "1.0.0",
    },
    createAccount(),
    {
      createCheckedAt: () => "2026-04-09T00:00:00.000Z",
      parseSessionJson: () =>
        createRequestConfig({
          expiresAt: "2000-01-01T00:00:00.000Z",
        }),
    },
  );

  assert.equal(result.status, "disable-and-skip");
  assert.match(result.message, /Session expired/);
});

test("checkStoredAccountHealth treats rate limits as transient without disabling", async () => {
  const result = await checkStoredAccountHealth(
    {
      getSessionSecret: () => "unused",
      manifestVersion: "1.0.0",
    },
    createAccount(),
    {
      createCheckedAt: () => "2026-04-09T00:00:00.000Z",
      parseSessionJson: () => createRequestConfig(),
      validateConversationListAccess: async () => {
        throw new ChatGptRequestError("ChatGPT request failed", 429, '{"error":"rate_limited"}');
      },
    },
  );

  assert.equal(result.status, "transient-keep-enabled");
  assert.match(result.message, /rate limit/i);
});

test("checkStoredAccountHealth treats rate-limit pause errors as transient without disabling", async () => {
  const result = await checkStoredAccountHealth(
    {
      getSessionSecret: () => "unused",
      manifestVersion: "1.0.0",
    },
    createAccount(),
    {
      createCheckedAt: () => "2026-04-09T00:00:00.000Z",
      parseSessionJson: () => createRequestConfig(),
      validateConversationListAccess: async () => {
        throw new ConsecutiveRateLimitPauseError(6);
      },
    },
  );

  assert.equal(result.status, "transient-keep-enabled");
  assert.match(result.message, /rate limit/i);
});

test("checkStoredAccountHealth disables invalid session access errors", async () => {
  const result = await checkStoredAccountHealth(
    {
      getSessionSecret: () => "unused",
      manifestVersion: "1.0.0",
    },
    createAccount(),
    {
      createCheckedAt: () => "2026-04-09T00:00:00.000Z",
      parseSessionJson: () => createRequestConfig(),
      validateConversationListAccess: async () => {
        throw new ChatGptRequestError("ChatGPT request failed", 401, '{"error":"unauthorized"}');
      },
    },
  );

  assert.equal(result.status, "disable-and-skip");
  assert.match(result.message, /Session access is invalid/);
});

test("checkRequestConfigHealth succeeds and returns request config", async () => {
  const requestConfig = createRequestConfig();
  const result = await checkRequestConfigHealth(requestConfig, {
    createCheckedAt: () => "2026-04-09T00:00:00.000Z",
    validateConversationListAccess: async () => undefined,
  });

  assert.equal(result.status, "healthy");
  assert.equal(result.requestConfig, requestConfig);
});
