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
  fetchedCount: number;
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
  maxPageRequests: number;
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

function finalizeFetchedConversationSummaries(pages: ConversationListPageFetchResult[]): ConversationSummary[] {
  const merged = new Map<string, ConversationSummary>();

  for (const page of [...pages].sort((left, right) => left.offset - right.offset)) {
    for (const summary of page.pageSummaries) {
      const existing = merged.get(summary.id);
      if (!existing) {
        merged.set(summary.id, summary);
        continue;
      }

      merged.set(summary.id, pickPreferredSummary(existing, summary));
    }
  }

  return sortConversationSummariesByCreatedAtDesc(Array.from(merged.values()));
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
  const pages: ConversationListPageFetchResult[] = [];
  const discoveredIds = new Set<string>();
  let expectedTotal: number | null = null;
  let pagesFetched = 0;

  const recordPage = (offset: number, pageInfo: ConversationListPageInfo, pageSummaries: ConversationSummary[]): void => {
    pages.push({
      offset,
      pageInfo,
      pageSummaries,
    });
    pagesFetched += 1;
    if (pageInfo.total !== null) {
      expectedTotal = expectedTotal === null ? pageInfo.total : Math.max(expectedTotal, pageInfo.total);
    }

    for (const summary of pageSummaries) {
      discoveredIds.add(summary.id);
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

  if (firstPage.pageSummaries.length === 0 || options.maxPageRequests === 1) {
    const summaries = finalizeFetchedConversationSummaries(pages);
    return {
      summaries,
      pagesFetched,
      fetchedCount: summaries.length,
    };
  }

  if (!shouldFetchNextConversationListPage(firstPage.pageSummaries.length, firstPage.pageInfo, options.pageLimit)) {
    const summaries = finalizeFetchedConversationSummaries(pages);
    return {
      summaries,
      pagesFetched,
      fetchedCount: summaries.length,
    };
  }

  const nextOffset = getNextConversationListOffset(0, firstPage.pageInfo, options.pageLimit);

  if (expectedTotal !== null) {
    const remainingOffsets: number[] = [];

    for (
      let offset = nextOffset;
      offset < expectedTotal && remainingOffsets.length < options.maxPageRequests - 1;
      offset += options.pageLimit
    ) {
      remainingOffsets.push(offset);
    }

    await runParallelOffsets(remainingOffsets, options.parallelism, async (offset) => {
      const page = await fetchPage(offset);
      recordPage(offset, page.pageInfo, page.pageSummaries);
    });
  } else {
    let offset = nextOffset;

    for (let pageIndex = 1; pageIndex < options.maxPageRequests; pageIndex += 1) {
      const page = await fetchPage(offset);
      recordPage(offset, page.pageInfo, page.pageSummaries);

      if (page.pageSummaries.length === 0) {
        break;
      }

      if (!shouldFetchNextConversationListPage(page.pageSummaries.length, page.pageInfo, options.pageLimit)) {
        break;
      }

      if (expectedTotal !== null && discoveredIds.size >= expectedTotal) {
        break;
      }

      offset = getNextConversationListOffset(offset, page.pageInfo, options.pageLimit);
    }
  }

  const summaries = finalizeFetchedConversationSummaries(pages);

  return {
    summaries,
    pagesFetched,
    fetchedCount: summaries.length,
  };
}
