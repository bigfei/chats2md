import { DEFAULT_CONVERSATION_LIST_LATEST_LIMIT, normalizeConversationListLatestLimit } from "../main/helpers";
import { shouldPromptForDateRange, type ConversationUpdatedAtSpan } from "./date-range";

export function resolveEffectiveConversationListLimit(defaultLimit: number, overrideLimit?: number): number {
  const normalizedDefault = normalizeConversationListLatestLimit(defaultLimit, DEFAULT_CONVERSATION_LIST_LATEST_LIMIT);

  return normalizeConversationListLatestLimit(overrideLimit, normalizedDefault);
}

export function shouldPromptConversationRangeSelection(
  fetchFullConversationList: boolean,
  span: ConversationUpdatedAtSpan | null,
): boolean {
  return fetchFullConversationList && shouldPromptForDateRange(span);
}
