import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchConversationSummariesWithPageFetcher,
  sortConversationSummariesByCreatedAtDesc,
  type ConversationListPageInfo,
} from "../src/chatgpt/conversation-list-fetch.ts";
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
      maxPageRequests: 10,
      parallelism: 3,
    },
  );

  assert.deepEqual(requestedOffsets, [0, 2, 4]);
  assert.equal(result.pagesFetched, 3);
  assert.deepEqual(
    result.summaries.map((summary) => summary.id),
    ["e", "d", "c", "b", "a"],
  );
});

test("fetchConversationSummariesWithPageFetcher limits conversation-list concurrency to three", async () => {
  const waitMs = 10;
  let inFlight = 0;
  let maxInFlight = 0;

  const result = await fetchConversationSummariesWithPageFetcher(
    async (offset) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      inFlight -= 1;

      return {
        pageInfo: createPageInfo(offset, 2, 8),
        pageSummaries: [
          createSummary(`conv-${offset}-a`, `2026-03-${String(10 + offset).padStart(2, "0")}T00:00:00.000Z`),
          createSummary(`conv-${offset}-b`, `2026-03-${String(11 + offset).padStart(2, "0")}T00:00:00.000Z`),
        ],
      };
    },
    {
      pageLimit: 2,
      maxPageRequests: 10,
      parallelism: 3,
    },
  );

  assert.equal(result.pagesFetched, 4);
  assert.equal(maxInFlight, 3);
});
