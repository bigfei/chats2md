import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryCacheStore,
  MemoryCheckpointStore,
  SyncCancelledError,
  createSyncEngine,
  type SyncSourceAdapter,
} from "../src/index.ts";

interface Summary {
  id: string;
  createdAt: string;
}

interface RecordPayload {
  id: string;
  body: string;
}

test("sync engine applies date ranges and item limits to seeded summaries", async () => {
  const processedIds: string[] = [];
  const source: SyncSourceAdapter<null, Summary, RecordPayload, string> = {
    sourceId: "seeded",
    capabilities: {
      full: true,
      dateRange: true,
    },
    getSummaryId: (summary) => summary.id,
    getSummaryCreatedAt: (summary) => summary.createdAt,
    listPage: async () => ({
      items: [],
      nextCursor: null,
    }),
    fetchRecord: async ({ summary }) => ({
      record: {
        id: summary.id,
        body: `body:${summary.id}`,
      },
      checkpoint: `checkpoint:${summary.id}`,
    }),
  };

  const engine = createSyncEngine({
    source,
    onRecord: async ({ record }) => {
      processedIds.push(record.id);
    },
  });

  const result = await engine.run({
    mode: "date-range",
    dateRange: {
      start: "2026-04-02",
      end: "2026-04-03",
    },
    itemLimit: 1,
    seedSummaries: [
      { id: "a", createdAt: "2026-04-01T00:00:00.000Z" },
      { id: "b", createdAt: "2026-04-02T00:00:00.000Z" },
      { id: "c", createdAt: "2026-04-03T00:00:00.000Z" },
    ],
  });

  assert.deepEqual(processedIds, ["c"]);
  assert.equal(result.discoveredSummaries.length, 3);
  assert.equal(result.selectedSummaries.length, 1);
});

test("sync engine uses caches and persists checkpoints", async () => {
  const cacheStore = new MemoryCacheStore();
  const checkpointStore = new MemoryCheckpointStore<number, string>();
  const calls = {
    list: 0,
    record: 0,
  };
  const source: SyncSourceAdapter<number, Summary, RecordPayload, string> = {
    sourceId: "cached-source",
    capabilities: {
      full: true,
      delta: true,
    },
    getSummaryId: (summary) => summary.id,
    getSummaryCreatedAt: (summary) => summary.createdAt,
    getListPageCacheKey: ({ cursor }) => `list:${cursor ?? 0}`,
    getRecordCacheKey: ({ summary }) => `record:${summary.id}`,
    listPage: async ({ cursor }) => {
      calls.list += 1;
      if ((cursor ?? 0) > 0) {
        return {
          items: [],
          nextCursor: null,
          checkpoint: "page-2",
        };
      }

      return {
        items: [
          { id: "a", createdAt: "2026-04-01T00:00:00.000Z" },
          { id: "b", createdAt: "2026-04-02T00:00:00.000Z" },
        ],
        nextCursor: 1,
        checkpoint: "page-1",
      };
    },
    fetchRecord: async ({ summary }) => {
      calls.record += 1;
      return {
        record: {
          id: summary.id,
          body: `body:${summary.id}`,
        },
        checkpoint: `record:${summary.id}`,
      };
    },
  };

  const engine = createSyncEngine({
    source,
    cacheStore,
    checkpointStore,
  });

  await engine.run({
    mode: "delta",
    checkpoint: {
      key: "sync",
      scope: "tests",
    },
  });

  assert.deepEqual(calls, {
    list: 2,
    record: 2,
  });

  const storedCheckpoint = await checkpointStore.get("tests:sync");
  assert.ok(storedCheckpoint);
  assert.equal(storedCheckpoint?.lastProcessedSummaryId, "b");
  assert.equal(storedCheckpoint?.sourceCheckpoint, "record:b");

  await engine.run({
    mode: "delta",
    checkpoint: {
      key: "sync",
      scope: "tests",
    },
  });

  assert.deepEqual(calls, {
    list: 2,
    record: 2,
  });
});

test("sync engine can retry a summary after a caller-managed recoverable error", async () => {
  const attempts: string[] = [];
  let shouldRetry = true;
  const source: SyncSourceAdapter<null, Summary, RecordPayload, null> = {
    sourceId: "retry-source",
    capabilities: {
      full: true,
    },
    getSummaryId: (summary) => summary.id,
    listPage: async () => ({
      items: [],
      nextCursor: null,
    }),
    fetchRecord: async ({ summary }) => {
      attempts.push(summary.id);
      if (shouldRetry) {
        shouldRetry = false;
        throw new Error("retry-me");
      }

      return {
        record: {
          id: summary.id,
          body: "ok",
        },
        checkpoint: null,
      };
    },
  };

  const engine = createSyncEngine({
    source,
    onSummaryError: async (error) => {
      if (error.message === "retry-me") {
        return "retry";
      }

      return "throw";
    },
  });

  const result = await engine.run({
    mode: "full",
    seedSummaries: [{ id: "a", createdAt: "2026-04-01T00:00:00.000Z" }],
  });

  assert.deepEqual(attempts, ["a", "a"]);
  assert.equal(result.processedCount, 1);
  assert.equal(result.failureCount, 0);
});

test("sync engine aborts with SyncCancelledError when the caller asks to abort after an error", async () => {
  const source: SyncSourceAdapter<null, Summary, RecordPayload, null> = {
    sourceId: "abort-source",
    capabilities: {
      full: true,
    },
    getSummaryId: (summary) => summary.id,
    listPage: async () => ({
      items: [],
      nextCursor: null,
    }),
    fetchRecord: async () => {
      throw new Error("fatal");
    },
  };

  const engine = createSyncEngine({
    source,
    onSummaryError: async () => "abort",
  });

  await assert.rejects(
    engine.run({
      mode: "full",
      seedSummaries: [{ id: "a", createdAt: "2026-04-01T00:00:00.000Z" }],
    }),
    SyncCancelledError,
  );
});
