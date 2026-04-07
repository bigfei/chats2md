import { getNextConversationListOffset, shouldFetchNextConversationListPage } from "./conversation-utils";

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

export interface FetchConversationSummariesPageProgress {
  pageNumber: number;
  offset: number;
  pageLimit: number;
  pageCount: number;
  discoveredUniqueCount: number;
  expectedTotal: number | null;
}

export interface FetchConversationSummariesWithPageFetcherOptions {
  pageLimit: number;
  parallelism: number;
  onPageFetched?: (progress: FetchConversationSummariesPageProgress) => void;
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
  return summaries
    .map((summary, index) => ({
      summary,
      index,
      createdAt: parseSummaryTimestamp(summary.createdAt),
    }))
    .sort((left, right) => {
      const leftRank = left.createdAt ?? Number.NEGATIVE_INFINITY;
      const rightRank = right.createdAt ?? Number.NEGATIVE_INFINITY;

      if (leftRank !== rightRank) {
        return rightRank - leftRank;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.summary);
}

async function runParallelOffsets(
  offsets: number[],
  parallelism: number,
  worker: (offset: number) => Promise<void>,
): Promise<void> {
  const queue = [...offsets];
  const workerCount = Math.max(1, Math.min(parallelism, queue.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const offset = queue.shift();
        if (typeof offset !== "number") {
          return;
        }

        await worker(offset);
      }
    }),
  );
}

export async function fetchConversationSummariesWithPageFetcher(
  fetchPage: (offset: number) => Promise<Omit<ConversationListPageFetchResult, "offset">>,
  options: FetchConversationSummariesWithPageFetcherOptions,
): Promise<FetchConversationSummariesResult> {
  const mergedSummaries = new Map<string, ConversationSummary>();
  const discoveredIds = new Set<string>();
  let expectedTotal: number | null = null;
  let pagesFetched = 0;
  let rawItemCount = 0;

  const recordPage = (
    offset: number,
    pageInfo: ConversationListPageInfo,
    pageSummaries: ConversationSummary[],
  ): void => {
    pagesFetched += 1;
    rawItemCount += pageSummaries.length;
    if (pageInfo.total !== null) {
      expectedTotal = expectedTotal === null ? pageInfo.total : Math.max(expectedTotal, pageInfo.total);
    }

    for (const summary of pageSummaries) {
      discoveredIds.add(summary.id);
      const existing = mergedSummaries.get(summary.id);
      if (!existing) {
        mergedSummaries.set(summary.id, summary);
        continue;
      }

      mergedSummaries.set(summary.id, pickPreferredSummary(existing, summary));
    }

    options.onPageFetched?.({
      pageNumber: Math.floor(offset / options.pageLimit) + 1,
      offset,
      pageLimit: options.pageLimit,
      pageCount: pageSummaries.length,
      discoveredUniqueCount: discoveredIds.size,
      expectedTotal,
    });
  };

  const firstPage = await fetchPage(0);
  recordPage(0, firstPage.pageInfo, firstPage.pageSummaries);

  if (firstPage.pageSummaries.length === 0) {
    const summaries = sortConversationSummariesByCreatedAtDesc(Array.from(mergedSummaries.values()));
    return {
      summaries,
      pagesFetched,
      rawItemCount,
      uniqueConversationCount: summaries.length,
    };
  }

  if (!shouldFetchNextConversationListPage(firstPage.pageSummaries.length, firstPage.pageInfo, options.pageLimit)) {
    const summaries = sortConversationSummariesByCreatedAtDesc(Array.from(mergedSummaries.values()));
    return {
      summaries,
      pagesFetched,
      rawItemCount,
      uniqueConversationCount: summaries.length,
    };
  }

  let nextOffset = getNextConversationListOffset(0, firstPage.pageInfo, options.pageLimit);

  while (true) {
    const batchOffsets = Array.from(
      { length: options.parallelism },
      (_value, index) => nextOffset + index * options.pageLimit,
    );
    const batchResults = new Map<number, Omit<ConversationListPageFetchResult, "offset">>();

    await runParallelOffsets(batchOffsets, options.parallelism, async (offset) => {
      const page = await fetchPage(offset);
      batchResults.set(offset, page);
    });

    let shouldContinue = true;
    let nextBatchOffset: number | null = null;

    for (const offset of [...batchOffsets].sort((left, right) => left - right)) {
      const page = batchResults.get(offset);
      if (!page) {
        continue;
      }

      recordPage(offset, page.pageInfo, page.pageSummaries);

      if (!shouldContinue) {
        continue;
      }

      if (page.pageSummaries.length === 0) {
        shouldContinue = false;
        continue;
      }

      if (!shouldFetchNextConversationListPage(page.pageSummaries.length, page.pageInfo, options.pageLimit)) {
        shouldContinue = false;
        continue;
      }

      nextBatchOffset = getNextConversationListOffset(offset, page.pageInfo, options.pageLimit);
    }

    if (!shouldContinue || nextBatchOffset === null) {
      break;
    }

    nextOffset = nextBatchOffset;
  }

  const summaries = sortConversationSummariesByCreatedAtDesc(Array.from(mergedSummaries.values()));

  return {
    summaries,
    pagesFetched,
    rawItemCount,
    uniqueConversationCount: summaries.length,
  };
}
