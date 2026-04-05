import assert from "node:assert/strict";
import test from "node:test";

import { resolveAssetFolderPaths } from "../src/storage/asset-storage.ts";

test("resolveAssetFolderPaths returns global target for global mode", () => {
  const paths = resolveAssetFolderPaths({
    mode: "global_by_conversation",
    baseFolder: "Imports/ChatGPT",
    conversationPathTemplate: "{email}/{account_id}/{slug}",
    conversation: {
      id: "conv-123",
      title: "Asset Test",
      updatedAt: "2026-04-05T08:00:00.000Z"
    },
    account: {
      accountId: "acc-1",
      email: "user@example.com"
    }
  });

  assert.equal(paths.targetFolderPath, "Imports/ChatGPT/_assets/acc-1");
  assert.equal(paths.globalFolderPath, "Imports/ChatGPT/_assets/acc-1");
  assert.equal(paths.localFolderPath, "Imports/ChatGPT/user@example.com/acc-1/_assets");
  assert.deepEqual(paths.candidateFolderPaths, [
    "Imports/ChatGPT/_assets/acc-1/conv-123",
    "Imports/ChatGPT/user@example.com/acc-1/_assets/conv-123"
  ]);
});

test("resolveAssetFolderPaths returns local target for with_conversation mode", () => {
  const paths = resolveAssetFolderPaths({
    mode: "with_conversation",
    baseFolder: "Imports/ChatGPT",
    conversationPathTemplate: "{date}/{slug}",
    conversation: {
      id: "conv-456",
      title: "Another Asset Test",
      updatedAt: "2026-04-05T08:00:00.000Z"
    },
    account: {
      accountId: "acc-2",
      email: "owner@example.com"
    }
  });

  assert.equal(paths.targetFolderPath, "Imports/ChatGPT/2026-04-05/_assets");
  assert.equal(paths.globalFolderPath, "Imports/ChatGPT/_assets/acc-2");
  assert.equal(paths.localFolderPath, "Imports/ChatGPT/2026-04-05/_assets");
  assert.deepEqual(paths.candidateFolderPaths, [
    "Imports/ChatGPT/_assets/acc-2/conv-456",
    "Imports/ChatGPT/2026-04-05/_assets/conv-456"
  ]);
});
