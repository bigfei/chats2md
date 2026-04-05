import type { ConversationSummary } from "./types";

export interface ShouldStopLatestListFetchOptions {
  fetchedSummaries: ConversationSummary[];
  limit: number;
  staleCutoffTimestampMs: number | null;
}

function parseTimestamp(value: string): number | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeOldestTimestampMs(summaries: ConversationSummary[]): number | null {
  let oldest = Number.POSITIVE_INFINITY;

  for (const summary of summaries) {
    const timestamp = parseTimestamp(summary.updatedAt);
    if (timestamp === null) {
      continue;
    }

    oldest = Math.min(oldest, timestamp);
  }

  return Number.isFinite(oldest) ? oldest : null;
}

function pickPreferredSummary(
  existing: ConversationSummary,
  candidate: ConversationSummary,
  preferCandidateOnTie: boolean
): ConversationSummary {
  const existingTimestamp = parseTimestamp(existing.updatedAt);
  const candidateTimestamp = parseTimestamp(candidate.updatedAt);

  const existingRank = existingTimestamp ?? Number.NEGATIVE_INFINITY;
  const candidateRank = candidateTimestamp ?? Number.NEGATIVE_INFINITY;

  if (candidateRank > existingRank) {
    return candidate;
  }

  if (candidateRank < existingRank) {
    return existing;
  }

  return preferCandidateOnTie ? candidate : existing;
}

export function rankConversationSummariesByUpdatedAt(
  summaries: ConversationSummary[]
): ConversationSummary[] {
  return summaries
    .map((summary, index) => ({
      summary,
      index,
      timestamp: parseTimestamp(summary.updatedAt)
    }))
    .sort((left, right) => {
      const leftRank = left.timestamp ?? Number.NEGATIVE_INFINITY;
      const rightRank = right.timestamp ?? Number.NEGATIVE_INFINITY;

      if (leftRank !== rightRank) {
        return rightRank - leftRank;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.summary);
}

export function trimConversationSummaries(
  summaries: ConversationSummary[],
  limit: number
): ConversationSummary[] {
  if (!Number.isFinite(limit)) {
    return [];
  }

  const normalizedLimit = Math.max(0, Math.trunc(limit));
  if (normalizedLimit === 0) {
    return [];
  }

  return rankConversationSummariesByUpdatedAt(summaries)
    .slice(0, Math.min(normalizedLimit, summaries.length));
}

export function mergeFetchedAndCachedConversationSummaries(
  fetchedSummaries: ConversationSummary[],
  cachedSummaries: ConversationSummary[],
  limit: number
): ConversationSummary[] {
  if (!Number.isFinite(limit)) {
    return [];
  }

  const normalizedLimit = Math.max(0, Math.trunc(limit));
  if (normalizedLimit === 0) {
    return [];
  }

  const merged = new Map<string, ConversationSummary>();

  for (const summary of cachedSummaries) {
    const existing = merged.get(summary.id);
    if (!existing) {
      merged.set(summary.id, summary);
      continue;
    }

    merged.set(summary.id, pickPreferredSummary(existing, summary, false));
  }

  for (const summary of fetchedSummaries) {
    const existing = merged.get(summary.id);
    if (!existing) {
      merged.set(summary.id, summary);
      continue;
    }

    merged.set(summary.id, pickPreferredSummary(existing, summary, true));
  }

  return trimConversationSummaries(Array.from(merged.values()), normalizedLimit);
}

export function getLatestWindowOldestTimestampMs(
  summaries: ConversationSummary[],
  limit: number
): number | null {
  return computeOldestTimestampMs(trimConversationSummaries(summaries, limit));
}

export function shouldStopLatestListFetch(
  options: ShouldStopLatestListFetchOptions
): boolean {
  const normalizedLimit = Math.max(1, Math.trunc(options.limit));

  if (options.fetchedSummaries.length >= normalizedLimit) {
    return true;
  }

  if (options.staleCutoffTimestampMs === null) {
    return false;
  }

  const oldestFetchedTimestamp = computeOldestTimestampMs(options.fetchedSummaries);
  if (oldestFetchedTimestamp === null) {
    return false;
  }

  return oldestFetchedTimestamp <= options.staleCutoffTimestampMs;
}
