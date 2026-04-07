import assert from "node:assert/strict";
import test from "node:test";

import { shouldFetchConversationDetail } from "../src/sync/skip-existing.ts";

test("shouldFetchConversationDetail skips existing local conversations when enabled", () => {
  assert.equal(shouldFetchConversationDetail(true, true), false);
});

test("shouldFetchConversationDetail still fetches missing conversations when skipping is enabled", () => {
  assert.equal(shouldFetchConversationDetail(false, true), true);
});

test("shouldFetchConversationDetail fetches existing local conversations when skipping is disabled", () => {
  assert.equal(shouldFetchConversationDetail(true, false), true);
});
