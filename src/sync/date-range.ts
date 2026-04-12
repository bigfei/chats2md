import {
  filterItemsByDateRange,
  getItemDateSpan,
  limitItems,
  sortItemsByDateDesc,
  toIsoUtcDate,
  type ItemDateSpan,
} from "@chats2md/sync-core";

import type { ConversationSummary } from "../shared/types";

export interface ConversationCreatedAtSpan extends ItemDateSpan {
  minCreatedAt: string;
  maxCreatedAt: string;
}

export function getConversationCreatedAtSpan(summaries: ConversationSummary[]): ConversationCreatedAtSpan | null {
  const span = getItemDateSpan(summaries, (summary) => summary.createdAt);

  if (!span) {
    return null;
  }

  return {
    ...span,
    minCreatedAt: span.minValue,
    maxCreatedAt: span.maxValue,
  };
}

export function filterConversationSummariesByCreatedDateRange(
  summaries: ConversationSummary[],
  startDate: string,
  endDate: string,
): ConversationSummary[] {
  return filterItemsByDateRange(summaries, startDate, endDate, (summary) => summary.createdAt);
}

export function filterConversationSummariesByLatestCreatedCount(
  summaries: ConversationSummary[],
  count: number,
): ConversationSummary[] {
  return limitItems(summaries, count, (items) => sortItemsByDateDesc(items, (summary) => summary.createdAt));
}

export { toIsoUtcDate };
