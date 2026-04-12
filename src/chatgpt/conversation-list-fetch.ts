import { getNextConversationListOffset, shouldFetchNextConversationListPage } from "./conversation-utils";
import { collectOffsetPaginatedItems, sortItemsByDateDesc } from "@chats2md/sync-core";
import { retryTransientOperation } from "../sync/transient-retry";

import type { ConversationSummary } from "../shared/types";

export interface ConversationListPageInfo {
  limit: number;
  offset: number;
  total: number | null;
}

export interface FetchConversationSummariesResult {
  summaries: ConversationSummary[];
  pagesFetched: number;
  rawItemCount: number;
  uniqueConversationCount: number;
}

export class ConversationListPageFetchError extends Error {
  readonly offset: number;
  readonly limit: number;
  readonly attempts: number;
  readonly maxAttempts: number;

  constructor(offset: number, limit: number, attempts: number, maxAttempts: number, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `Conversation-list request failed after ${attempts}/${maxAttempts} attempts (offset=${offset}, limit=${limit}): ${message}`,
    );
    this.name = "ConversationListPageFetchError";
    this.offset = offset;
    this.limit = limit;
    this.attempts = attempts;
    this.maxAttempts = maxAttempts;
  }
}

export interface FetchConversationSummariesPageProgress {
  pageNumber: number;
  offset: number;
  pageLimit: number;
  pageCount: number;
  discoveredUniqueCount: number;
  expectedTotal: number | null;
}

export interface FetchConversationSummariesPageRetryProgress {
  offset: number;
  pageLimit: number;
  attemptNumber: number;
  maxAttempts: number;
  message: string;
}

export interface FetchConversationSummariesWithPageFetcherOptions {
  pageLimit: number;
  parallelism: number;
  retryAttempts?: number;
  onPageFetched?: (progress: FetchConversationSummariesPageProgress) => void;
  onPageRetry?: (progress: FetchConversationSummariesPageRetryProgress) => void;
  getRetryDelayMs?: (attemptNumber: number) => number;
  signal?: AbortSignal;
}

interface ConversationListPageFetchResult {
  offset: number;
  pageInfo: ConversationListPageInfo;
  pageSummaries: ConversationSummary[];
}

function parseSummaryTimestamp(value: string): number | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickPreferredSummary(existing: ConversationSummary, candidate: ConversationSummary): ConversationSummary {
  const existingUpdatedAt = parseSummaryTimestamp(existing.updatedAt) ?? Number.NEGATIVE_INFINITY;
  const candidateUpdatedAt = parseSummaryTimestamp(candidate.updatedAt) ?? Number.NEGATIVE_INFINITY;

  if (candidateUpdatedAt > existingUpdatedAt) {
    return candidate;
  }

  return existing;
}

export function sortConversationSummariesByCreatedAtDesc(summaries: ConversationSummary[]): ConversationSummary[] {
  return sortItemsByDateDesc(summaries, (summary) => summary.createdAt);
}

export async function fetchConversationSummariesWithPageFetcher(
  fetchPage: (offset: number) => Promise<Omit<ConversationListPageFetchResult, "offset">>,
  options: FetchConversationSummariesWithPageFetcherOptions,
): Promise<FetchConversationSummariesResult> {
  const result = await collectOffsetPaginatedItems(
    async (offset) => {
      const page = await fetchPageWithContext(offset, fetchPage, options);
      return {
        pageInfo: page.pageInfo,
        items: page.pageSummaries,
      };
    },
    {
      pageLimit: options.pageLimit,
      parallelism: options.parallelism,
      signal: options.signal,
      getItemId: (summary) => summary.id,
      mergeItem: pickPreferredSummary,
      sortItems: sortConversationSummariesByCreatedAtDesc,
      onPageFetched: (progress) => {
        options.onPageFetched?.({
          pageNumber: progress.pageNumber,
          offset: progress.offset,
          pageLimit: progress.pageLimit,
          pageCount: progress.pageCount,
          discoveredUniqueCount: progress.discoveredUniqueCount,
          expectedTotal: progress.expectedTotal,
        });
      },
      shouldContinue: (page) =>
        shouldFetchNextConversationListPage(page.items.length, page.pageInfo, options.pageLimit),
      getNextOffset: (offset, page) => getNextConversationListOffset(offset, page.pageInfo, options.pageLimit),
    },
  );

  return {
    summaries: result.items,
    pagesFetched: result.pagesFetched,
    rawItemCount: result.rawItemCount,
    uniqueConversationCount: result.uniqueItemCount,
  };
}

async function fetchPageWithContext(
  offset: number,
  fetchPage: (offset: number) => Promise<Omit<ConversationListPageFetchResult, "offset">>,
  options: FetchConversationSummariesWithPageFetcherOptions,
): Promise<Omit<ConversationListPageFetchResult, "offset">> {
  const retryAttempts = Math.max(1, Math.trunc(options.retryAttempts ?? 3));

  return retryTransientOperation(() => fetchPage(offset), {
    maxAttempts: retryAttempts,
    signal: options.signal,
    getDelayMs: options.getRetryDelayMs,
    onRetry: (progress) => {
      options.onPageRetry?.({
        offset,
        pageLimit: options.pageLimit,
        attemptNumber: progress.nextAttemptNumber,
        maxAttempts: progress.maxAttempts,
        message: progress.message,
      });
    },
    wrapFinalError: (error, attempts, maxAttempts) =>
      new ConversationListPageFetchError(offset, options.pageLimit, attempts, maxAttempts, error),
  });
}
