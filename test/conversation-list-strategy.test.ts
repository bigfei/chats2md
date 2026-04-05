import assert from "node:assert/strict";
import test from "node:test";

import {
  getLatestWindowOldestTimestampMs,
  mergeFetchedAndCachedConversationSummaries,
  rankConversationSummariesByUpdatedAt,
  shouldStopLatestListFetch,
  trimConversationSummaries
} from "../src/conversation-list-strategy.ts";
import type { ConversationSummary } from "../src/types.ts";

function createSummary(id: string, updatedAt: string, title = id): ConversationSummary {
  return {
    id,
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    url: `https://chatgpt.com/c/${id}`
  };
}

test("rankConversationSummariesByUpdatedAt sorts newest first and pushes invalid timestamps last", () => {
  const ranked = rankConversationSummariesByUpdatedAt([
    createSummary("third", "2026-03-03T00:00:00.000Z"),
    createSummary("invalid", "not-a-date"),
    createSummary("latest", "2026-03-05T00:00:00.000Z"),
    createSummary("second", "2026-03-04T00:00:00.000Z")
  ]);

  assert.deepEqual(ranked.map((summary) => summary.id), ["latest", "second", "third", "invalid"]);
});

test("mergeFetchedAndCachedConversationSummaries dedupes by id and prefers newer fetched records", () => {
  const cached = [
    createSummary("a", "2026-03-01T00:00:00.000Z", "cached-a"),
    createSummary("b", "2026-03-02T00:00:00.000Z", "cached-b")
  ];
  const fetched = [
    createSummary("a", "2026-03-05T00:00:00.000Z", "fetched-a"),
    createSummary("c", "2026-03-03T00:00:00.000Z", "fetched-c")
  ];

  const merged = mergeFetchedAndCachedConversationSummaries(fetched, cached, 3);
  assert.deepEqual(merged.map((summary) => summary.id), ["a", "c", "b"]);
  assert.equal(merged[0]?.title, "fetched-a");
});

test("mergeFetchedAndCachedConversationSummaries prefers fetched record on tie", () => {
  const cached = [createSummary("same", "2026-03-02T00:00:00.000Z", "cached")];
  const fetched = [createSummary("same", "2026-03-02T00:00:00.000Z", "fetched")];

  const merged = mergeFetchedAndCachedConversationSummaries(fetched, cached, 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.title, "fetched");
});

test("trimConversationSummaries clamps to requested latest window", () => {
  const summaries = [
    createSummary("one", "2026-03-01T00:00:00.000Z"),
    createSummary("three", "2026-03-03T00:00:00.000Z"),
    createSummary("two", "2026-03-02T00:00:00.000Z")
  ];

  const trimmed = trimConversationSummaries(summaries, 2);
  assert.deepEqual(trimmed.map((summary) => summary.id), ["three", "two"]);
});

test("getLatestWindowOldestTimestampMs returns oldest timestamp within latest window", () => {
  const summaries = [
    createSummary("one", "2026-03-01T00:00:00.000Z"),
    createSummary("two", "2026-03-02T00:00:00.000Z"),
    createSummary("three", "2026-03-03T00:00:00.000Z")
  ];

  const oldestMs = getLatestWindowOldestTimestampMs(summaries, 2);
  assert.equal(oldestMs, Date.parse("2026-03-02T00:00:00.000Z"));
});

test("shouldStopLatestListFetch stops when fetched window reaches limit", () => {
  const shouldStop = shouldStopLatestListFetch({
    fetchedSummaries: [
      createSummary("one", "2026-03-01T00:00:00.000Z"),
      createSummary("two", "2026-03-02T00:00:00.000Z")
    ],
    limit: 2,
    staleCutoffTimestampMs: null
  });

  assert.equal(shouldStop, true);
});

test("shouldStopLatestListFetch stops when fetched oldest crosses stale cutoff", () => {
  const shouldStop = shouldStopLatestListFetch({
    fetchedSummaries: [
      createSummary("newer", "2026-03-05T00:00:00.000Z"),
      createSummary("older", "2026-03-01T00:00:00.000Z")
    ],
    limit: 5,
    staleCutoffTimestampMs: Date.parse("2026-03-02T00:00:00.000Z")
  });

  assert.equal(shouldStop, true);
});

test("shouldStopLatestListFetch keeps fetching when below limit and still newer than stale cutoff", () => {
  const shouldStop = shouldStopLatestListFetch({
    fetchedSummaries: [
      createSummary("newer", "2026-03-05T00:00:00.000Z"),
      createSummary("middle", "2026-03-04T00:00:00.000Z")
    ],
    limit: 5,
    staleCutoffTimestampMs: Date.parse("2026-03-03T00:00:00.000Z")
  });

  assert.equal(shouldStop, false);
});
