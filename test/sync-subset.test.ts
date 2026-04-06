import assert from "node:assert/strict";
import test from "node:test";

import { getConversationSyncSubsetFieldState } from "../src/ui/sync-subset.ts";

test("full discovered range hides both optional subset inputs", () => {
  assert.deepEqual(getConversationSyncSubsetFieldState("all"), {
    showDateRange: false,
    showLatestCount: false,
  });
});

test("created_at date range shows only date inputs", () => {
  assert.deepEqual(getConversationSyncSubsetFieldState("range"), {
    showDateRange: true,
    showLatestCount: false,
  });
});

test("latest count shows only latest count input", () => {
  assert.deepEqual(getConversationSyncSubsetFieldState("latest-count"), {
    showDateRange: false,
    showLatestCount: true,
  });
});
