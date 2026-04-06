import type { ConversationSummary } from "../shared/types";

const DAY_MS = 24 * 60 * 60 * 1000;
export const ONE_MONTH_SYNC_RANGE_MS = 30 * DAY_MS;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ConversationCreatedAtSpan {
  minCreatedAt: string;
  maxCreatedAt: string;
  spanMs: number;
  validCount: number;
}

function parseTimestamp(value: string): number | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIsoDateAtUtc(date: string, time: string): number | null {
  if (!ISO_DATE_PATTERN.test(date)) {
    return null;
  }

  const parsed = Date.parse(`${date}T${time}Z`);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString().slice(0, 10) === date ? parsed : null;
}

function parseIsoDateStart(date: string): number | null {
  return parseIsoDateAtUtc(date, "00:00:00.000");
}

function parseIsoDateEnd(date: string): number | null {
  return parseIsoDateAtUtc(date, "23:59:59.999");
}

export function toIsoUtcDate(value: string): string | null {
  const parsed = parseTimestamp(value);
  if (parsed === null) {
    return null;
  }

  return new Date(parsed).toISOString().slice(0, 10);
}

export function getConversationCreatedAtSpan(summaries: ConversationSummary[]): ConversationCreatedAtSpan | null {
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;
  let minCreatedAt = "";
  let maxCreatedAt = "";
  let validCount = 0;

  for (const summary of summaries) {
    const timestamp = parseTimestamp(summary.createdAt);
    if (timestamp === null) {
      continue;
    }

    validCount += 1;

    if (timestamp < minTimestamp) {
      minTimestamp = timestamp;
      minCreatedAt = summary.createdAt;
    }

    if (timestamp > maxTimestamp) {
      maxTimestamp = timestamp;
      maxCreatedAt = summary.createdAt;
    }
  }

  if (validCount === 0) {
    return null;
  }

  return {
    minCreatedAt,
    maxCreatedAt,
    spanMs: Math.max(0, maxTimestamp - minTimestamp),
    validCount,
  };
}

export function shouldPromptForDateRange(span: ConversationCreatedAtSpan | null): boolean {
  return (span?.spanMs ?? 0) > ONE_MONTH_SYNC_RANGE_MS;
}

export function filterConversationSummariesByCreatedDateRange(
  summaries: ConversationSummary[],
  startDate: string,
  endDate: string,
): ConversationSummary[] {
  const startTimestamp = parseIsoDateStart(startDate);
  const endTimestamp = parseIsoDateEnd(endDate);

  if (startTimestamp === null || endTimestamp === null) {
    throw new Error("Date range must use YYYY-MM-DD format.");
  }

  if (startTimestamp > endTimestamp) {
    throw new Error("Date range start date must be before or equal to end date.");
  }

  return summaries.filter((summary) => {
    const timestamp = parseTimestamp(summary.createdAt);
    return timestamp !== null && timestamp >= startTimestamp && timestamp <= endTimestamp;
  });
}
