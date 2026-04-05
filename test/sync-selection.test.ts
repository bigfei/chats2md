import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveEffectiveConversationListLimit,
  shouldPromptConversationRangeSelection,
} from "../src/sync/selection.ts";
import type { ConversationUpdatedAtSpan } from "../src/sync/date-range.ts";

function createSpan(spanMs: number): ConversationUpdatedAtSpan {
  return {
    minUpdatedAt: "2026-01-01T00:00:00.000Z",
    maxUpdatedAt: "2026-01-31T00:00:00.000Z",
    spanMs,
    validCount: 2,
  };
}

test("resolveEffectiveConversationListLimit uses override when valid", () => {
  assert.equal(resolveEffectiveConversationListLimit(200, 350), 350);
});

test("resolveEffectiveConversationListLimit falls back to normalized default", () => {
  assert.equal(resolveEffectiveConversationListLimit(200, 0), 200);
  assert.equal(resolveEffectiveConversationListLimit(0, undefined), 200);
});

test("shouldPromptConversationRangeSelection is false for latest-window mode", () => {
  const shouldPrompt = shouldPromptConversationRangeSelection(false, createSpan(31 * 24 * 60 * 60 * 1000));
  assert.equal(shouldPrompt, false);
});

test("shouldPromptConversationRangeSelection is true for full-list mode with long span", () => {
  const shouldPrompt = shouldPromptConversationRangeSelection(true, createSpan(31 * 24 * 60 * 60 * 1000));
  assert.equal(shouldPrompt, true);
});

test("shouldPromptConversationRangeSelection is false when span is missing", () => {
  const shouldPrompt = shouldPromptConversationRangeSelection(true, null);
  assert.equal(shouldPrompt, false);
});
