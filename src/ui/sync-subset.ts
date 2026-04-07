import type { ConversationSyncDateRangeSelection } from "../shared/types";

export type ConversationSyncSubsetMode = "all" | "range" | "latest-count";

export interface ConversationSyncSubsetFieldState {
  showDateRange: boolean;
  showLatestCount: boolean;
}

export function getConversationSyncSubsetFieldState(
  mode: ConversationSyncSubsetMode,
): ConversationSyncSubsetFieldState {
  return {
    showDateRange: mode === "range",
    showLatestCount: mode === "latest-count",
  };
}

export function resolveSkipExistingLocalConversations(value: boolean | null | undefined): boolean {
  return value !== false;
}

export function withSkipExistingLocalConversations(
  selection:
    | { mode: "all" }
    | { mode: "range"; startDate: string; endDate: string }
    | { mode: "latest-count"; count: number },
  skipExistingLocalConversations: boolean,
): ConversationSyncDateRangeSelection {
  return {
    ...selection,
    skipExistingLocalConversations,
  };
}
