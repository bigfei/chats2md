import assert from "node:assert/strict";
import test from "node:test";

import {
  getConversationSyncSubsetFieldState,
  resolveSkipExistingLocalConversations,
  withSkipExistingLocalConversations,
} from "../src/ui/sync-subset.ts";

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

test("skip-existing toggle defaults on unless explicitly disabled", () => {
  assert.equal(resolveSkipExistingLocalConversations(undefined), true);
  assert.equal(resolveSkipExistingLocalConversations(true), true);
  assert.equal(resolveSkipExistingLocalConversations(false), false);
});

test("subset selections carry skip-existing toggle state", () => {
  assert.deepEqual(withSkipExistingLocalConversations({ mode: "all" }, true), {
    mode: "all",
    skipExistingLocalConversations: true,
  });
  assert.deepEqual(
    withSkipExistingLocalConversations(
      {
        mode: "range",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
      },
      false,
    ),
    {
      mode: "range",
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      skipExistingLocalConversations: false,
    },
  );
  assert.deepEqual(withSkipExistingLocalConversations({ mode: "latest-count", count: 10 }, true), {
    mode: "latest-count",
    count: 10,
    skipExistingLocalConversations: true,
  });
});
