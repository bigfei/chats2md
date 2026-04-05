import type { ConversationSummary } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
export const ONE_MONTH_SYNC_RANGE_MS = 30 * DAY_MS;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ConversationUpdatedAtSpan {
  minUpdatedAt: string;
  maxUpdatedAt: string;
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

export function getConversationUpdatedAtSpan(
  summaries: ConversationSummary[]
): ConversationUpdatedAtSpan | null {
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;
  let minUpdatedAt = "";
  let maxUpdatedAt = "";
  let validCount = 0;

  for (const summary of summaries) {
    const timestamp = parseTimestamp(summary.updatedAt);
    if (timestamp === null) {
      continue;
    }

    validCount += 1;

    if (timestamp < minTimestamp) {
      minTimestamp = timestamp;
      minUpdatedAt = summary.updatedAt;
    }

    if (timestamp > maxTimestamp) {
      maxTimestamp = timestamp;
      maxUpdatedAt = summary.updatedAt;
    }
  }

  if (validCount === 0) {
    return null;
  }

  return {
    minUpdatedAt,
    maxUpdatedAt,
    spanMs: Math.max(0, maxTimestamp - minTimestamp),
    validCount
  };
}

export function shouldPromptForDateRange(span: ConversationUpdatedAtSpan | null): boolean {
  return (span?.spanMs ?? 0) > ONE_MONTH_SYNC_RANGE_MS;
}

export function filterConversationSummariesByUpdatedDateRange(
  summaries: ConversationSummary[],
  startDate: string,
  endDate: string
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
    const timestamp = parseTimestamp(summary.updatedAt);
    return timestamp !== null && timestamp >= startTimestamp && timestamp <= endTimestamp;
  });
}
