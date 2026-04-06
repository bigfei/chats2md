import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMovedConversationFolderCleanupPlans,
  cleanupEmptyFolders,
  cleanupMigratedAssetSourceFolders,
  cleanupMovedConversationFolders,
  findSharedFolderPath,
  listFolderCleanupPaths,
} from "../src/main/folder-cleanup.ts";

interface MockFolder {
  path: string;
  children: Array<MockFolder | { path: string }>;
}

function createMockVault(folderPaths: string[]): {
  vault: {
    getAbstractFileByPath(path: string): unknown;
    delete(file: unknown): Promise<void>;
  };
} {
  const folders = new Map<string, MockFolder>();

  const ensureFolder = (path: string): MockFolder => {
    const existing = folders.get(path);
    if (existing) {
      return existing;
    }

    const folder: MockFolder = {
      path,
      children: [],
    };
    folders.set(path, folder);

    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parentPath) {
      const parent = ensureFolder(parentPath);
      parent.children.push(folder);
    }

    return folder;
  };

  folderPaths.forEach((path) => ensureFolder(path));

  return {
    vault: {
      getAbstractFileByPath(path: string): unknown {
        return folders.get(path) ?? null;
      },
      async delete(file: unknown): Promise<void> {
        const folder = file as MockFolder;
        const parentPath = folder.path.includes("/") ? folder.path.slice(0, folder.path.lastIndexOf("/")) : "";
        const parent = folders.get(parentPath);

        if (parent) {
          parent.children = parent.children.filter((child) => child !== folder);
        }

        folders.delete(folder.path);
      },
    },
  };
}

test("findSharedFolderPath returns the deepest shared folder", () => {
  assert.equal(
    findSharedFolderPath("Imports/ChatGPT/2026-04-01", "Imports/ChatGPT/2026-04-02"),
    "Imports/ChatGPT",
  );
  assert.equal(findSharedFolderPath("OldRoot/2026-04-01", "NewRoot/2026-04-02"), "");
});

test("listFolderCleanupPaths walks upward until the stop folder", () => {
  assert.deepEqual(listFolderCleanupPaths("Imports/ChatGPT/2026-04-01/_assets", "Imports/ChatGPT"), [
    "Imports/ChatGPT/2026-04-01/_assets",
    "Imports/ChatGPT/2026-04-01",
  ]);
});

test("buildMovedConversationFolderCleanupPlans includes old note and local asset folders", () => {
  assert.deepEqual(
    buildMovedConversationFolderCleanupPlans(
      "Imports/ChatGPT/2026-04-01/Hello.md",
      "Imports/ChatGPT/2026-04-02/Hello.md",
      "with_conversation",
    ),
    [
      {
        startFolderPath: "Imports/ChatGPT/2026-04-01/_assets",
        stopBeforePath: "Imports/ChatGPT",
      },
      {
        startFolderPath: "Imports/ChatGPT/2026-04-01",
        stopBeforePath: "Imports/ChatGPT",
      },
    ],
  );
});

test("buildMovedConversationFolderCleanupPlans still includes old local assets when current mode is global", () => {
  assert.deepEqual(
    buildMovedConversationFolderCleanupPlans(
      "Imports/ChatGPT/2026-04-01/Hello.md",
      "Imports/ChatGPT/2026-04-02/Hello.md",
      "global_by_conversation",
    ),
    [
      {
        startFolderPath: "Imports/ChatGPT/2026-04-01/_assets",
        stopBeforePath: "Imports/ChatGPT",
      },
      {
        startFolderPath: "Imports/ChatGPT/2026-04-01",
        stopBeforePath: "Imports/ChatGPT",
      },
    ],
  );
});

test("cleanupEmptyFolders deletes only consecutive empty folders", async () => {
  const app = createMockVault([
    "Imports",
    "Imports/ChatGPT",
    "Imports/ChatGPT/2026-04-01",
    "Imports/ChatGPT/2026-04-01/_assets",
    "Imports/ChatGPT/2026-04-02",
  ]);

  const removed = await cleanupEmptyFolders(app, "Imports/ChatGPT/2026-04-01/_assets", "Imports/ChatGPT");

  assert.deepEqual(removed, ["Imports/ChatGPT/2026-04-01/_assets", "Imports/ChatGPT/2026-04-01"]);
  assert.notEqual(app.vault.getAbstractFileByPath("Imports/ChatGPT"), null);
});

test("cleanupMovedConversationFolders removes empty old note folders after a move", async () => {
  const app = createMockVault([
    "Imports",
    "Imports/ChatGPT",
    "Imports/ChatGPT/2026-04-01",
    "Imports/ChatGPT/2026-04-01/_assets",
    "Imports/ChatGPT/2026-04-02",
  ]);

  const removed = await cleanupMovedConversationFolders(
    app,
    "Imports/ChatGPT/2026-04-01/Hello.md",
    "Imports/ChatGPT/2026-04-02/Hello.md",
    "with_conversation",
  );

  assert.deepEqual(removed, ["Imports/ChatGPT/2026-04-01/_assets", "Imports/ChatGPT/2026-04-01"]);
});

test("cleanupMigratedAssetSourceFolders removes empty source folders but keeps the target", async () => {
  const app = createMockVault([
    "Imports",
    "Imports/ChatGPT",
    "Imports/ChatGPT/2026-04-01",
    "Imports/ChatGPT/2026-04-01/_assets",
    "Imports/ChatGPT/2026-04-01/_assets/conv-123",
  ]);

  const removed = await cleanupMigratedAssetSourceFolders(
    app,
    ["Imports/ChatGPT/2026-04-01/_assets/conv-123"],
    "Imports/ChatGPT/2026-04-01/_assets",
  );

  assert.deepEqual(removed, ["Imports/ChatGPT/2026-04-01/_assets/conv-123"]);
  assert.notEqual(app.vault.getAbstractFileByPath("Imports/ChatGPT/2026-04-01/_assets"), null);
});
