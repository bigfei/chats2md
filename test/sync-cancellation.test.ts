import assert from "node:assert/strict";
import test from "node:test";

import {
  SyncCancelledError,
  isSyncCancelledError,
  raceWithAbort,
  sleepWithAbort,
  toSyncCancelledError,
} from "../src/sync/cancellation.ts";

test("toSyncCancelledError normalizes abort reasons", () => {
  assert.equal(toSyncCancelledError("stopped").message, "stopped");
  assert.equal(toSyncCancelledError(new Error("halt")).message, "halt");
  assert.equal(toSyncCancelledError().message, "Sync stopped by user.");
});

test("raceWithAbort rejects with SyncCancelledError when aborted", async () => {
  const controller = new AbortController();
  const pending = new Promise<string>((resolve) => {
    globalThis.setTimeout(() => resolve("done"), 50);
  });

  const result = raceWithAbort(pending, controller.signal);
  controller.abort("stopped");

  await assert.rejects(result, (error: unknown) => {
    assert.equal(isSyncCancelledError(error), true);
    assert.equal((error as SyncCancelledError).message, "stopped");
    return true;
  });
});

test("sleepWithAbort rejects when aborted", async () => {
  const controller = new AbortController();
  const sleeping = sleepWithAbort(1000, controller.signal);

  controller.abort();

  await assert.rejects(sleeping, (error: unknown) => {
    assert.equal(isSyncCancelledError(error), true);
    return true;
  });
});
