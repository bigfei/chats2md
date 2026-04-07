import assert from "node:assert/strict";
import test from "node:test";

import { shouldRestoreActiveSyncModal } from "../src/main/sync-modal-state.ts";

test("shouldRestoreActiveSyncModal reopens a minimized sync dialog", () => {
  assert.equal(
    shouldRestoreActiveSyncModal({
      syncWorkerActive: true,
      activeModalIsSyncing: true,
      activeModalCanReopen: true,
    }),
    true,
  );
});

test("shouldRestoreActiveSyncModal does not reopen a dialog after close requested stop", () => {
  assert.equal(
    shouldRestoreActiveSyncModal({
      syncWorkerActive: true,
      activeModalIsSyncing: true,
      activeModalCanReopen: false,
    }),
    false,
  );
});

test("shouldRestoreActiveSyncModal reopens a still-running dialog when no worker lock remains", () => {
  assert.equal(
    shouldRestoreActiveSyncModal({
      syncWorkerActive: false,
      activeModalIsSyncing: true,
      activeModalCanReopen: false,
    }),
    true,
  );
});
