import { DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE, normalizeDefaultLatestConversationCount } from "../main/helpers";
import { DEFAULT_SYNC_TUNING_SETTINGS, type StoredSessionAccount, type SyncTuningSettings } from "../shared/types";

import type { AccountHealthResult } from "../main/account-health";

export const CUSTOM_TEMPLATE_OPTION = "__custom__";
export const DEFAULT_CONVERSATION_PATH_TEMPLATE = "{date}/{slug}";
export const CONVERSATION_PATH_TEMPLATE_DESCRIPTION_LINES = [
  "Relative note path template, without .md.",
  "{date}: conversation created date (YYYY-MM-DD)",
  "{slug}: sanitized conversation title",
  "{email}: account email",
  "{account_id}: ChatGPT account ID",
  "{conversation_id}: ChatGPT conversation ID",
];

type AdvancedNumberSettingKey = Exclude<keyof SyncTuningSettings, "defaultLatestConversationCount">;

export interface AdvancedNumberSettingDefinition {
  key: AdvancedNumberSettingKey;
  name: string;
  desc: string;
  placeholder: string;
}

export function normalizeConversationPathTemplateInput(value: string): string {
  return value.trim() || DEFAULT_CONVERSATION_PATH_TEMPLATE;
}

export function normalizeSyncReportFolderInput(value: string): string {
  return value.trim() || DEFAULT_SYNC_REPORT_FOLDER_TEMPLATE;
}

export function parseSettingsNumberInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeDefaultLatestConversationCountInput(value: string): number | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  return normalizeDefaultLatestConversationCount(Number.parseInt(trimmed, 10));
}

export function buildSyncReportCleanupNotice(
  result: { removedPaths: string[]; keptPaths: string[] },
  keepLatest?: number,
): string {
  if (keepLatest !== undefined) {
    return result.removedPaths.length > 0
      ? `Removed ${result.removedPaths.length} sync report/log file(s). Kept ${result.keptPaths.length}.`
      : `No sync report/log files removed. ${result.keptPaths.length} file(s) kept.`;
  }

  return result.removedPaths.length > 0
    ? `Removed ${result.removedPaths.length} sync report/log file(s).`
    : "No generated sync report/log files found to remove.";
}

export function buildAccountDescriptionLines(
  account: StoredSessionAccount,
  healthResult?: AccountHealthResult,
): string[] {
  const lines = [
    `Status: ${account.disabled ? "Disabled" : "Enabled"}`,
    `User ID: ${account.userId || "Unavailable"}`,
    `Account ID: ${account.accountId}`,
    `Expires: ${account.expiresAt || "Unavailable"}`,
  ];

  if (healthResult) {
    lines.push(`Health check: ${healthResult.status === "healthy" ? "Healthy" : "Unhealthy"}`);
    lines.push(`Last check: ${healthResult.checkedAt}`);
    if (healthResult.status !== "healthy") {
      lines.push(`Health issue: ${healthResult.message}`);
    }
  }

  return lines;
}

export function summarizeAccountHealthResults(results: Iterable<AccountHealthResult>): {
  healthyCount: number;
  unhealthyCount: number;
  notice: string;
} {
  let healthyCount = 0;
  let unhealthyCount = 0;

  for (const result of results) {
    if (result.status === "healthy") {
      healthyCount += 1;
    } else {
      unhealthyCount += 1;
    }
  }

  return {
    healthyCount,
    unhealthyCount,
    notice: `Account health check complete. ${healthyCount} healthy, ${unhealthyCount} unhealthy.`,
  };
}

export function createAdvancedNumberSettingDefinitions(
  defaults: SyncTuningSettings = DEFAULT_SYNC_TUNING_SETTINGS,
): AdvancedNumberSettingDefinition[] {
  return [
    {
      key: "conversationListFetchParallelism",
      name: "Conversation-list parallel fetches",
      desc: `Default: ${defaults.conversationListFetchParallelism}. Number of conversation-list pages fetched in parallel.`,
      placeholder: String(defaults.conversationListFetchParallelism),
    },
    {
      key: "conversationListRetryAttempts",
      name: "Conversation-list retry attempts",
      desc: `Default: ${defaults.conversationListRetryAttempts}. Retries for failed conversation-list API calls.`,
      placeholder: String(defaults.conversationListRetryAttempts),
    },
    {
      key: "conversationDetailRetryAttempts",
      name: "Conversation-detail retry attempts",
      desc: `Default: ${defaults.conversationDetailRetryAttempts}. Retries for failed conversation-detail API calls.`,
      placeholder: String(defaults.conversationDetailRetryAttempts),
    },
    {
      key: "conversationDetailBrowseDelayMinMs",
      name: "Detail browse delay minimum (ms)",
      desc: `Default: ${defaults.conversationDetailBrowseDelayMinMs}. Lower bound for randomized wait before opening a conversation.`,
      placeholder: String(defaults.conversationDetailBrowseDelayMinMs),
    },
    {
      key: "conversationDetailBrowseDelayMaxMs",
      name: "Detail browse delay maximum (ms)",
      desc: `Default: ${defaults.conversationDetailBrowseDelayMaxMs}. Upper bound for randomized wait before opening a conversation.`,
      placeholder: String(defaults.conversationDetailBrowseDelayMaxMs),
    },
    {
      key: "maxConsecutiveRateLimitResponses",
      name: "Pause after consecutive 429s",
      desc: `Default: ${defaults.maxConsecutiveRateLimitResponses}. Pause sync when ChatGPT keeps rate-limiting requests.`,
      placeholder: String(defaults.maxConsecutiveRateLimitResponses),
    },
  ];
}
