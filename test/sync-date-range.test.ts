import assert from "node:assert/strict";
import test from "node:test";

import {
  ONE_MONTH_SYNC_RANGE_MS,
  filterConversationSummariesByCreatedDateRange,
  filterConversationSummariesByLatestCreatedCount,
  getConversationCreatedAtSpan,
  shouldPromptForDateRange,
} from "../src/sync/date-range.ts";
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

test("shouldPromptForDateRange is false when created_at span is exactly 30 days", () => {
  const summaries = [
    createSummary("conv-1", "2026-01-01T00:00:00.000Z"),
    createSummary("conv-2", "2026-01-31T00:00:00.000Z"),
  ];

  const span = getConversationCreatedAtSpan(summaries);
  assert.ok(span);
  assert.equal(span.spanMs, ONE_MONTH_SYNC_RANGE_MS);
  assert.equal(shouldPromptForDateRange(span), false);
});

test("shouldPromptForDateRange is true when created_at span is greater than 30 days", () => {
  const summaries = [
    createSummary("conv-1", "2026-01-01T00:00:00.000Z"),
    createSummary("conv-2", "2026-02-01T00:00:00.000Z"),
  ];

  const span = getConversationCreatedAtSpan(summaries);
  assert.ok(span);
  assert.equal(shouldPromptForDateRange(span), true);
});

test("filterConversationSummariesByCreatedDateRange keeps inclusive boundaries", () => {
  const summaries = [
    createSummary("before", "2026-02-28T23:59:59.999Z"),
    createSummary("start-boundary", "2026-03-01T00:00:00.000Z"),
    createSummary("middle", "2026-03-15T12:00:00.000Z"),
    createSummary("end-boundary", "2026-03-31T23:59:59.999Z"),
    createSummary("after", "2026-04-01T00:00:00.000Z"),
  ];

  const filtered = filterConversationSummariesByCreatedDateRange(summaries, "2026-03-01", "2026-03-31");

  assert.deepEqual(
    filtered.map((summary) => summary.id),
    ["start-boundary", "middle", "end-boundary"],
  );
});

test("invalid created_at values are ignored by span and range filtering", () => {
  const summaries = [
    createSummary("invalid", "not-a-date"),
    createSummary("early", "2026-01-01T00:00:00.000Z"),
    createSummary("late", "2026-02-05T12:00:00.000Z"),
  ];

  const span = getConversationCreatedAtSpan(summaries);
  assert.ok(span);
  assert.equal(span.validCount, 2);
  assert.equal(span.minCreatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(span.maxCreatedAt, "2026-02-05T12:00:00.000Z");

  const filtered = filterConversationSummariesByCreatedDateRange(summaries, "2026-01-01", "2026-01-31");
  assert.deepEqual(
    filtered.map((summary) => summary.id),
    ["early"],
  );
});

test("filterConversationSummariesByLatestCreatedCount returns newest created conversations first", () => {
  const summaries = [
    createSummary("third", "2026-03-03T00:00:00.000Z"),
    createSummary("invalid", "not-a-date"),
    createSummary("latest", "2026-03-05T12:00:00.000Z"),
    createSummary("second", "2026-03-04T00:00:00.000Z"),
  ];

  const filtered = filterConversationSummariesByLatestCreatedCount(summaries, 2);
  assert.deepEqual(
    filtered.map((summary) => summary.id),
    ["latest", "second"],
  );
});

test("filterConversationSummariesByLatestCreatedCount clamps to all conversations", () => {
  const summaries = [
    createSummary("one", "2026-03-01T00:00:00.000Z"),
    createSummary("two", "2026-03-02T00:00:00.000Z"),
  ];

  const filtered = filterConversationSummariesByLatestCreatedCount(summaries, 99);
  assert.deepEqual(
    filtered.map((summary) => summary.id),
    ["two", "one"],
  );
});

test("filterConversationSummariesByLatestCreatedCount rejects invalid count", () => {
  const summaries = [createSummary("one", "2026-03-01T00:00:00.000Z")];
  assert.throws(() => filterConversationSummariesByLatestCreatedCount(summaries, 0), /positive integer/);
});
