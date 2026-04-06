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
