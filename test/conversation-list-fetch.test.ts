import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationListPageFetchError,
  fetchConversationSummariesWithPageFetcher,
  sortConversationSummariesByCreatedAtDesc,
  type ConversationListPageInfo,
} from "../src/chatgpt/conversation-list-fetch.ts";
import { SyncCancelledError } from "../src/sync/cancellation.ts";
import type { ConversationSummary } from "../src/shared/types.ts";

function createSummary(id: string, createdAt: string, updatedAt = createdAt): ConversationSummary {
  return {
    id,
    title: id,
    createdAt,
    updatedAt,
    url: `https://chatgpt.com/c/${id}`,
  };
}

function createPageInfo(offset: number, limit: number, total: number | null): ConversationListPageInfo {
  return {
    offset,
    limit,
    total,
  };
}

test("sortConversationSummariesByCreatedAtDesc orders newest created conversations first", () => {
  const sorted = sortConversationSummariesByCreatedAtDesc([
    createSummary("middle", "2026-03-02T00:00:00.000Z"),
    createSummary("invalid", "not-a-date"),
    createSummary("latest", "2026-03-03T00:00:00.000Z"),
    createSummary("oldest", "2026-03-01T00:00:00.000Z"),
  ]);

  assert.deepEqual(
    sorted.map((summary) => summary.id),
    ["latest", "middle", "oldest", "invalid"],
  );
});

test("fetchConversationSummariesWithPageFetcher continues until pagination ends when total is unavailable", async () => {
  const pages = new Map<number, { pageInfo: ConversationListPageInfo; pageSummaries: ConversationSummary[] }>([
    [
      0,
      {
        pageInfo: createPageInfo(0, 2, null),
        pageSummaries: [createSummary("a", "2026-03-01T00:00:00.000Z"), createSummary("b", "2026-03-02T00:00:00.000Z")],
      },
    ],
    [
      2,
      {
        pageInfo: createPageInfo(2, 2, null),
        pageSummaries: [createSummary("c", "2026-03-03T00:00:00.000Z"), createSummary("d", "2026-03-04T00:00:00.000Z")],
      },
    ],
    [
      4,
      {
        pageInfo: createPageInfo(4, 2, null),
        pageSummaries: [createSummary("e", "2026-03-05T00:00:00.000Z")],
      },
    ],
  ]);

  const requestedOffsets: number[] = [];
  const result = await fetchConversationSummariesWithPageFetcher(
    async (offset) => {
      requestedOffsets.push(offset);
      const page = pages.get(offset);
      return (
        page ?? {
          pageInfo: createPageInfo(offset, 2, null),
          pageSummaries: [],
        }
      );
    },
    {
      pageLimit: 2,
      parallelism: 1,
    },
  );

  assert.deepEqual(requestedOffsets, [0, 2, 4]);
  assert.equal(result.pagesFetched, 3);
  assert.deepEqual(
    result.summaries.map((summary) => summary.id),
    ["e", "d", "c", "b", "a"],
  );
});

test("fetchConversationSummariesWithPageFetcher does not stop at the first page total", async () => {
  const pages = new Map<number, { pageInfo: ConversationListPageInfo; pageSummaries: ConversationSummary[] }>([
    [
      0,
      {
        pageInfo: createPageInfo(0, 100, 100),
        pageSummaries: Array.from({ length: 100 }, (_value, index) =>
          createSummary(`conv-${index}`, `2026-03-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
        ),
      },
    ],
    [
      100,
      {
        pageInfo: createPageInfo(100, 100, 199),
        pageSummaries: Array.from({ length: 100 }, (_value, index) =>
          createSummary(`conv-${100 + index}`, `2026-04-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
        ),
      },
    ],
    [
      200,
      {
        pageInfo: createPageInfo(200, 100, 250),
        pageSummaries: [
          createSummary("conv-200", "2026-05-01T00:00:00.000Z"),
          createSummary("conv-201", "2026-05-02T00:00:00.000Z"),
        ],
      },
    ],
  ]);

  const requestedOffsets: number[] = [];
  const result = await fetchConversationSummariesWithPageFetcher(
    async (offset) => {
      requestedOffsets.push(offset);
      const page = pages.get(offset);
      return (
        page ?? {
          pageInfo: createPageInfo(offset, 100, 250),
          pageSummaries: [],
        }
      );
    },
    {
      pageLimit: 100,
      parallelism: 3,
    },
  );

  assert.deepEqual(requestedOffsets, [0, 100, 200, 300]);
  assert.equal(result.pagesFetched, 4);
  assert.equal(result.rawItemCount, 202);
  assert.equal(result.uniqueConversationCount, 202);
  assert.equal(result.summaries[0]?.id, "conv-201");
});

test("fetchConversationSummariesWithPageFetcher can run conversation-list fetches serially", async () => {
  const waitMs = 10;
  let inFlight = 0;
  let maxInFlight = 0;

  const result = await fetchConversationSummariesWithPageFetcher(
    async (offset) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      inFlight -= 1;

      const pageSummaries =
        offset >= 6
          ? [createSummary(`conv-${offset}-a`, `2026-03-${String(10 + offset).padStart(2, "0")}T00:00:00.000Z`)]
          : [
              createSummary(`conv-${offset}-a`, `2026-03-${String(10 + offset).padStart(2, "0")}T00:00:00.000Z`),
              createSummary(`conv-${offset}-b`, `2026-03-${String(11 + offset).padStart(2, "0")}T00:00:00.000Z`),
            ];

      return {
        pageInfo: createPageInfo(offset, 2, 8),
        pageSummaries,
      };
    },
    {
      pageLimit: 2,
      parallelism: 1,
    },
  );

  assert.equal(result.pagesFetched, 4);
  assert.equal(maxInFlight, 1);
});

test("fetchConversationSummariesWithPageFetcher continues past 10,000 items when pagination continues", async () => {
  const pageLimit = 100;
  const totalPages = 105;
  const requestedOffsets: number[] = [];

  const result = await fetchConversationSummariesWithPageFetcher(
    async (offset) => {
      requestedOffsets.push(offset);
      const pageNumber = Math.floor(offset / pageLimit);

      if (pageNumber >= totalPages) {
        return {
          pageInfo: createPageInfo(offset, pageLimit, null),
          pageSummaries: [],
        };
      }

      return {
        pageInfo: createPageInfo(offset, pageLimit, null),
        pageSummaries: Array.from({ length: pageLimit }, (_value, index) =>
          createSummary(
            `conv-${offset + index}`,
            `2026-03-${String(((offset + index) % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
          ),
        ),
      };
    },
    {
      pageLimit,
      parallelism: 3,
    },
  );

  assert.equal(result.rawItemCount, pageLimit * totalPages);
  assert.equal(result.uniqueConversationCount, pageLimit * totalPages);
  assert.equal(result.pagesFetched, totalPages + 1);
  assert.equal(requestedOffsets[0], 0);
  assert.equal(requestedOffsets.at(-1), totalPages * pageLimit);
});

test("fetchConversationSummariesWithPageFetcher returns separate raw and unique counters when pages overlap", async () => {
  const result = await fetchConversationSummariesWithPageFetcher(
    async (offset) => {
      if (offset === 0) {
        return {
          pageInfo: createPageInfo(0, 2, null),
          pageSummaries: [
            createSummary("conv-1", "2026-03-01T00:00:00.000Z"),
            createSummary("conv-2", "2026-03-02T00:00:00.000Z"),
          ],
        };
      }

      if (offset === 2) {
        return {
          pageInfo: createPageInfo(2, 2, null),
          pageSummaries: [
            createSummary("conv-2", "2026-03-02T00:00:00.000Z", "2026-03-03T00:00:00.000Z"),
            createSummary("conv-3", "2026-03-04T00:00:00.000Z"),
          ],
        };
      }

      return {
        pageInfo: createPageInfo(offset, 2, null),
        pageSummaries: [],
      };
    },
    {
      pageLimit: 2,
      parallelism: 1,
    },
  );

  assert.equal(result.rawItemCount, 4);
  assert.equal(result.uniqueConversationCount, 3);
  assert.deepEqual(
    result.summaries.map((summary) => summary.id),
    ["conv-3", "conv-2", "conv-1"],
  );
});

test("fetchConversationSummariesWithPageFetcher retries transient page failures and reports retry context", async () => {
  const requestedOffsets: number[] = [];
  const retryProgress: string[] = [];
  let secondPageAttempts = 0;

  const result = await fetchConversationSummariesWithPageFetcher(
    async (offset) => {
      requestedOffsets.push(offset);

      if (offset === 0) {
        return {
          pageInfo: createPageInfo(0, 100, 101),
          pageSummaries: Array.from({ length: 100 }, (_value, index) =>
            createSummary(`conv-${index}`, `2026-03-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
          ),
        };
      }

      if (offset === 100) {
        secondPageAttempts += 1;

        if (secondPageAttempts < 3) {
          throw new Error(`temporary-${secondPageAttempts}`);
        }

        return {
          pageInfo: createPageInfo(100, 100, 101),
          pageSummaries: [createSummary("conv-100", "2026-05-01T00:00:00.000Z")],
        };
      }

      return {
        pageInfo: createPageInfo(offset, 100, 101),
        pageSummaries: [],
      };
    },
    {
      pageLimit: 100,
      parallelism: 1,
      getRetryDelayMs: () => 0,
      onPageRetry: (progress) => {
        retryProgress.push(
          `${progress.attemptNumber}/${progress.maxAttempts}:${progress.offset}:${progress.pageLimit}:${progress.message}`,
        );
      },
    },
  );

  assert.deepEqual(requestedOffsets, [0, 100, 100, 100]);
  assert.deepEqual(retryProgress, ["2/3:100:100:temporary-1", "3/3:100:100:temporary-2"]);
  assert.equal(result.rawItemCount, 101);
  assert.equal(result.uniqueConversationCount, 101);
  assert.equal(result.summaries[0]?.id, "conv-100");
});

test("fetchConversationSummariesWithPageFetcher wraps retry exhaustion with offset and attempts", async () => {
  const requestedOffsets: number[] = [];

  await assert.rejects(
    fetchConversationSummariesWithPageFetcher(
      async (offset) => {
        requestedOffsets.push(offset);

        if (offset === 0) {
          return {
            pageInfo: createPageInfo(0, 100, 201),
            pageSummaries: Array.from({ length: 100 }, (_value, index) =>
              createSummary(`conv-${index}`, `2026-03-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
            ),
          };
        }

        if (offset === 100) {
          throw new Error('ChatGPT request failed with HTTP 500: {"detail":"Request timeout"}');
        }

        return {
          pageInfo: createPageInfo(offset, 100, 201),
          pageSummaries: [],
        };
      },
      {
        pageLimit: 100,
        parallelism: 1,
        getRetryDelayMs: () => 0,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConversationListPageFetchError);
      assert.equal(error.offset, 100);
      assert.equal(error.limit, 100);
      assert.equal(error.attempts, 3);
      assert.equal(error.maxAttempts, 3);
      assert.match(error.message, /after 3\/3 attempts/);
      assert.match(error.message, /offset=100, limit=100/);
      return true;
    },
  );

  assert.deepEqual(requestedOffsets, [0, 100, 100, 100]);
});

test("fetchConversationSummariesWithPageFetcher stops retrying when canceled during backoff", async () => {
  const controller = new AbortController();
  let attempts = 0;

  await assert.rejects(
    fetchConversationSummariesWithPageFetcher(
      async () => {
        attempts += 1;
        throw new Error("temporary");
      },
      {
        pageLimit: 100,
        parallelism: 1,
        signal: controller.signal,
        onPageRetry: () => {
          controller.abort("stopped");
        },
        getRetryDelayMs: () => 0,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SyncCancelledError);
      assert.equal(error.message, "stopped");
      return true;
    },
  );

  assert.equal(attempts, 1);
});
