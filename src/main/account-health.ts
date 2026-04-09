import { ChatGptRequestError, isRateLimitedChatGptRequestError } from "../chatgpt/request-core";
import { parseSessionJson, validateConversationListAccess } from "../chatgpt/api";
import { isConsecutiveRateLimitPauseError } from "../sync/rate-limit-guard";

import type { ChatGptRequestConfig, StoredSessionAccount } from "../shared/types";

export type AccountHealthStatus = "healthy" | "disable-and-skip" | "transient-keep-enabled";

export interface AccountHealthResult {
  status: AccountHealthStatus;
  checkedAt: string;
  message: string;
  requestConfig?: ChatGptRequestConfig;
}

export interface AccountHealthHost {
  getSessionSecret(secretId: string): string | null;
  manifestVersion: string;
}

export interface AccountHealthDependencies {
  createCheckedAt?: () => string;
  parseSessionJson?: (rawSessionJson: string, manifestVersion: string) => ChatGptRequestConfig;
  validateConversationListAccess?: (config: ChatGptRequestConfig) => Promise<void>;
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt || expiresAt.trim().length === 0) {
    return false;
  }

  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}

function buildDefiniteFailure(checkedAt: string, message: string): AccountHealthResult {
  return {
    status: "disable-and-skip",
    checkedAt,
    message,
  };
}

function buildTransientFailure(checkedAt: string, message: string): AccountHealthResult {
  return {
    status: "transient-keep-enabled",
    checkedAt,
    message,
  };
}

function buildHealthy(checkedAt: string, requestConfig: ChatGptRequestConfig): AccountHealthResult {
  return {
    status: "healthy",
    checkedAt,
    message: "Account session is healthy.",
    requestConfig,
  };
}

function isInvalidSessionAccessError(error: unknown): boolean {
  if (!(error instanceof ChatGptRequestError)) {
    return false;
  }

  if (error.status === 401 || error.status === 403) {
    return true;
  }

  if (error.status === 400) {
    const body = error.bodyText.toLowerCase();
    return body.includes("expired") || body.includes("unauthorized") || body.includes("invalid");
  }

  return false;
}

function getCheckedAt(dependencies?: AccountHealthDependencies): string {
  return dependencies?.createCheckedAt?.() ?? new Date().toISOString();
}

function formatInvalidSessionJsonMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Invalid session JSON:") ? message : `Invalid session JSON: ${message}`;
}

function readSessionParser(
  dependencies?: AccountHealthDependencies,
): (rawSessionJson: string, manifestVersion: string) => ChatGptRequestConfig {
  return dependencies?.parseSessionJson ?? parseSessionJson;
}

function readConversationListValidator(
  dependencies?: AccountHealthDependencies,
): (config: ChatGptRequestConfig) => Promise<void> {
  return dependencies?.validateConversationListAccess ?? validateConversationListAccess;
}

function normalizeOptionalIdentityValue(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

function findAccountMismatch(account: StoredSessionAccount, requestConfig: ChatGptRequestConfig): string | null {
  if (requestConfig.accountId !== account.accountId) {
    return `expected ${account.accountId}, got ${requestConfig.accountId}`;
  }

  const expectedUserId = normalizeOptionalIdentityValue(account.userId);
  const actualUserId = normalizeOptionalIdentityValue(requestConfig.userId);
  if (expectedUserId && actualUserId && expectedUserId !== actualUserId) {
    return `expected user ${account.userId}, got ${requestConfig.userId}`;
  }

  const expectedEmail = normalizeOptionalIdentityValue(account.email);
  const actualEmail = normalizeOptionalIdentityValue(requestConfig.userEmail);
  if (expectedEmail && actualEmail && expectedEmail !== actualEmail) {
    return `expected email ${account.email}, got ${requestConfig.userEmail}`;
  }

  return null;
}

async function checkRequestConfigAccessHealth(
  requestConfig: ChatGptRequestConfig,
  checkedAt: string,
  dependencies?: AccountHealthDependencies,
): Promise<AccountHealthResult> {
  if (isExpired(requestConfig.expiresAt)) {
    return buildDefiniteFailure(checkedAt, `Session expired at ${requestConfig.expiresAt}.`);
  }

  try {
    await readConversationListValidator(dependencies)(requestConfig);
    return buildHealthy(checkedAt, requestConfig);
  } catch (error) {
    if (isInvalidSessionAccessError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      return buildDefiniteFailure(checkedAt, `Session access is invalid: ${message}`);
    }

    if (isRateLimitedChatGptRequestError(error) || isConsecutiveRateLimitPauseError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      return buildTransientFailure(checkedAt, `Health check hit a rate limit: ${message}`);
    }

    const message = error instanceof Error ? error.message : String(error);
    return buildTransientFailure(checkedAt, `Health check failed transiently: ${message}`);
  }
}

export async function checkRequestConfigHealth(
  requestConfig: ChatGptRequestConfig,
  dependencies?: AccountHealthDependencies,
): Promise<AccountHealthResult> {
  return checkRequestConfigAccessHealth(requestConfig, getCheckedAt(dependencies), dependencies);
}

export async function checkStoredAccountHealth(
  host: AccountHealthHost,
  account: StoredSessionAccount,
  dependencies?: AccountHealthDependencies,
): Promise<AccountHealthResult> {
  const checkedAt = getCheckedAt(dependencies);
  const raw = host.getSessionSecret(account.secretId);

  if (!raw || raw.trim().length === 0) {
    return buildDefiniteFailure(checkedAt, "Missing session secret payload.");
  }

  let requestConfig: ChatGptRequestConfig;
  try {
    requestConfig = readSessionParser(dependencies)(raw, host.manifestVersion);
  } catch (error) {
    return buildDefiniteFailure(checkedAt, formatInvalidSessionJsonMessage(error));
  }

  const mismatch = findAccountMismatch(account, requestConfig);
  if (mismatch) {
    return buildDefiniteFailure(checkedAt, `Stored account mismatch: ${mismatch}.`);
  }

  return checkRequestConfigAccessHealth(requestConfig, checkedAt, dependencies);
}

export function applyAccountHealthResult(account: StoredSessionAccount, result: AccountHealthResult): StoredSessionAccount {
  const disabled =
    result.status === "disable-and-skip"
      ? true
      : result.status === "healthy"
        ? false
        : account.disabled;

  return {
    ...account,
    disabled,
    lastHealthCheckAt: result.checkedAt,
    lastHealthCheckError: result.status === "healthy" ? undefined : result.message,
  };
}
