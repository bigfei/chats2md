import { retryOperation, type RetryProgress } from "./retry";

export interface OffsetPageInfo {
  limit: number;
  offset: number;
  total: number | null;
}

export interface OffsetPageResult<TItem> {
  pageInfo: OffsetPageInfo;
  items: TItem[];
}

export interface OffsetPageFetchedProgress {
  pageNumber: number;
  offset: number;
  pageLimit: number;
  pageCount: number;
  discoveredUniqueCount: number;
  expectedTotal: number | null;
}

export interface CollectOffsetPaginatedItemsOptions<TItem> {
  pageLimit: number;
  parallelism: number;
  retryAttempts?: number;
  signal?: AbortSignal;
  getItemId: (item: TItem) => string;
  mergeItem?: (existing: TItem, candidate: TItem) => TItem;
  sortItems?: (items: TItem[]) => TItem[];
  onPageFetched?: (progress: OffsetPageFetchedProgress) => void;
  onPageRetry?: (progress: RetryProgress & { offset: number; pageLimit: number }) => void;
  getRetryDelayMs?: (attemptNumber: number) => number;
  shouldContinue: (result: OffsetPageResult<TItem>) => boolean;
  getNextOffset: (currentOffset: number, result: OffsetPageResult<TItem>) => number;
}

export interface CollectOffsetPaginatedItemsResult<TItem> {
  items: TItem[];
  pagesFetched: number;
  rawItemCount: number;
  uniqueItemCount: number;
  expectedTotal: number | null;
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

export async function collectOffsetPaginatedItems<TItem>(
  fetchPage: (offset: number) => Promise<OffsetPageResult<TItem>>,
  options: CollectOffsetPaginatedItemsOptions<TItem>,
): Promise<CollectOffsetPaginatedItemsResult<TItem>> {
  const mergedItems = new Map<string, TItem>();
  const discoveredIds = new Set<string>();
  let pagesFetched = 0;
  let rawItemCount = 0;
  let expectedTotal: number | null = null;

  const mergeItem = options.mergeItem ?? ((_existing: TItem, candidate: TItem) => candidate);
  const sortItems = options.sortItems ?? ((items: TItem[]) => items);

  const recordPage = (offset: number, page: OffsetPageResult<TItem>): void => {
    pagesFetched += 1;
    rawItemCount += page.items.length;
    expectedTotal = page.pageInfo.total === null ? expectedTotal : Math.max(expectedTotal ?? 0, page.pageInfo.total);

    for (const item of page.items) {
      const id = options.getItemId(item);
      discoveredIds.add(id);
      const existing = mergedItems.get(id);
      mergedItems.set(id, existing ? mergeItem(existing, item) : item);
    }

    options.onPageFetched?.({
      pageNumber: Math.floor(offset / options.pageLimit) + 1,
      offset,
      pageLimit: options.pageLimit,
      pageCount: page.items.length,
      discoveredUniqueCount: discoveredIds.size,
      expectedTotal,
    });
  };

  const fetchPageWithRetry = async (offset: number): Promise<OffsetPageResult<TItem>> =>
    retryOperation(() => fetchPage(offset), {
      maxAttempts: Math.max(1, Math.trunc(options.retryAttempts ?? 1)),
      signal: options.signal,
      getDelayMs: options.getRetryDelayMs,
      onRetry: (progress) => {
        options.onPageRetry?.({
          ...progress,
          offset,
          pageLimit: options.pageLimit,
        });
      },
    });

  const firstPage = await fetchPageWithRetry(0);
  recordPage(0, firstPage);

  if (!options.shouldContinue(firstPage)) {
    const items = sortItems(Array.from(mergedItems.values()));
    return {
      items,
      pagesFetched,
      rawItemCount,
      uniqueItemCount: items.length,
      expectedTotal,
    };
  }

  let nextOffset = options.getNextOffset(0, firstPage);

  while (true) {
    const batchOffsets = Array.from(
      { length: Math.max(1, options.parallelism) },
      (_value, index) => nextOffset + index * options.pageLimit,
    );
    const batchResults = new Map<number, OffsetPageResult<TItem>>();

    await runParallelOffsets(batchOffsets, options.parallelism, async (offset) => {
      const page = await fetchPageWithRetry(offset);
      batchResults.set(offset, page);
    });

    let shouldContinue = true;
    let nextBatchOffset: number | null = null;

    for (const offset of [...batchOffsets].sort((left, right) => left - right)) {
      const page = batchResults.get(offset);
      if (!page) {
        continue;
      }

      recordPage(offset, page);

      if (!shouldContinue) {
        continue;
      }

      if (!options.shouldContinue(page)) {
        shouldContinue = false;
        continue;
      }

      nextBatchOffset = options.getNextOffset(offset, page);
    }

    if (!shouldContinue || nextBatchOffset === null) {
      break;
    }

    nextOffset = nextBatchOffset;
  }

  const items = sortItems(Array.from(mergedItems.values()));
  return {
    items,
    pagesFetched,
    rawItemCount,
    uniqueItemCount: items.length,
    expectedTotal,
  };
}
