import { Notice } from "obsidian";

import { parseSessionJson } from "../chatgpt/api";
import { SECRET_ID_PREFIX, removeStoredAccount, upsertStoredAccountMetadata } from "./helpers";
import { clearStoredSecretPayload } from "./secret-storage";
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
  const account = upsertStoredAccountMetadata(host.settings, requestConfig, secretId);
  host.setLegacySessionMigrationWarning(null);

  if (host.settings.legacySessionJson.trim().length > 0) {
    host.settings.legacySessionJson = "";
  }

  await host.saveSettings();
  return account;
}

export async function removeSessionAccount(host: MainSessionAccountHost, accountId: string): Promise<void> {
  // Obsidian SecretStorage has no delete API as of 1.11.4, so clear the payload in place.
  clearStoredSecretPayload(host.settings, accountId, (key, value) => host.app.secretStorage.setSecret(key, value));

  removeStoredAccount(host.settings, accountId);
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
    upsertStoredAccountMetadata(host.settings, parsed, secretId);
    host.settings.legacySessionJson = "";
    host.setLegacySessionMigrationWarning(null);
    await host.saveSettings();
    new Notice("Legacy session JSON was migrated into secret storage.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.setLegacySessionMigrationWarning(`Legacy Session JSON migration failed: ${message}`);
  }
}
