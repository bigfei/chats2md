import { Notice } from "obsidian";

import { parseSessionJson } from "../chatgpt/api";
import { SECRET_ID_PREFIX, removeAccountAndConversationListCache, sortAccounts } from "./helpers";
import type { ChatGptRequestConfig, Chats2MdSettings, StoredSessionAccount } from "../shared/types";

export interface MainSessionAccountHost {
  app: {
    secretStorage: {
      setSecret(key: string, value: string): void;
    };
  };
  manifestVersion: string;
  settings: Chats2MdSettings;
  setLegacySessionMigrationWarning(value: string | null): void;
  saveSettings(): Promise<void>;
}

function upsertAccountMetadata(
  settings: Chats2MdSettings,
  requestConfig: ChatGptRequestConfig,
  secretId: string,
): StoredSessionAccount {
  const now = new Date().toISOString();
  const existing = settings.accounts.find((account) => account.accountId === requestConfig.accountId);

  const account: StoredSessionAccount = {
    accountId: requestConfig.accountId,
    userId: requestConfig.userId,
    email: requestConfig.userEmail,
    expiresAt: requestConfig.expiresAt,
    secretId,
    addedAt: existing?.addedAt ?? now,
    updatedAt: now,
  };

  settings.accounts = sortAccounts([
    ...settings.accounts.filter((item) => item.accountId !== requestConfig.accountId),
    account,
  ]);

  return account;
}

function buildSecretId(accountId: string): string {
  const normalizedPart = accountId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return `${SECRET_ID_PREFIX}-${normalizedPart || "account"}`;
}

export async function upsertSessionAccount(
  host: MainSessionAccountHost,
  rawSessionJson: string,
  parsed?: ChatGptRequestConfig,
): Promise<StoredSessionAccount> {
  const normalizedRaw = rawSessionJson.trim();

  if (!normalizedRaw) {
    throw new Error("Session JSON cannot be empty.");
  }

  const requestConfig = parsed ?? parseSessionJson(normalizedRaw, host.manifestVersion);
  const secretId = buildSecretId(requestConfig.accountId);

  host.app.secretStorage.setSecret(secretId, normalizedRaw);
  const account = upsertAccountMetadata(host.settings, requestConfig, secretId);
  host.setLegacySessionMigrationWarning(null);

  if (host.settings.legacySessionJson.trim().length > 0) {
    host.settings.legacySessionJson = "";
  }

  await host.saveSettings();
  return account;
}

export async function removeSessionAccount(host: MainSessionAccountHost, accountId: string): Promise<void> {
  removeAccountAndConversationListCache(host.settings, accountId);
  await host.saveSettings();
}

export async function migrateLegacySessionIfNeeded(host: MainSessionAccountHost): Promise<void> {
  const raw = host.settings.legacySessionJson.trim();

  if (!raw) {
    host.setLegacySessionMigrationWarning(null);
    return;
  }

  try {
    const parsed = parseSessionJson(raw, host.manifestVersion);
    const secretId = buildSecretId(parsed.accountId);
    host.app.secretStorage.setSecret(secretId, raw);
    upsertAccountMetadata(host.settings, parsed, secretId);
    host.settings.legacySessionJson = "";
    host.setLegacySessionMigrationWarning(null);
    await host.saveSettings();
    new Notice("Legacy Session JSON was migrated into Secret Storage.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.setLegacySessionMigrationWarning(`Legacy Session JSON migration failed: ${message}`);
  }
}
