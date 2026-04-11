import assert from "node:assert/strict";
import test from "node:test";

import { SyncRunLogger } from "../src/main/helpers.ts";
import { cleanupSyncReportFiles } from "../src/sync/report-cleanup.ts";

class MockFile {
  path: string;
  name: string;

  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() ?? path;
  }
}

class MockFolder {
  path: string;
  name: string;
  children: Array<MockFile | MockFolder>;

  constructor(path: string) {
    this.path = path;
    this.name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    this.children = [];
  }
}

class MockVault {
  readonly files = new Map<string, string>();
  readonly folders = new Map<string, MockFolder>();
  createCalls = 0;
  processCalls = 0;

  constructor() {
    this.ensureFolder("");
  }

  private ensureFolder(path: string): MockFolder {
    const existing = this.folders.get(path);
    if (existing) {
      return existing;
    }

    const folder = new MockFolder(path);
    this.folders.set(path, folder);

    if (path.length > 0) {
      const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const parent = this.ensureFolder(parentPath);
      if (!parent.children.includes(folder)) {
        parent.children.push(folder);
      }
    }

    return folder;
  }

  addFolder(path: string): void {
    this.ensureFolder(path);
  }

  getFileByPath(path: string): MockFile | null {
    if (!this.files.has(path)) {
      return null;
    }

    return new MockFile(path);
  }

  getAbstractFileByPath(path: string): MockFile | MockFolder | null {
    return this.getFileByPath(path) ?? this.folders.get(path) ?? null;
  }

  async create(path: string, content: string): Promise<MockFile> {
    this.createCalls += 1;
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const parent = this.ensureFolder(parentPath);
    const file = new MockFile(path);
    this.files.set(path, content);
    parent.children.push(file);
    return file;
  }

  async process(file: MockFile, fn: (content: string) => string): Promise<void> {
    this.processCalls += 1;
    const existing = this.files.get(file.path);

    if (typeof existing !== "string") {
      throw new Error(`Missing file: ${file.path}`);
    }

    this.files.set(file.path, fn(existing));
  }

  async trashFile(file: MockFile): Promise<void> {
    this.files.delete(file.path);
    const parentPath = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    const parent = this.folders.get(parentPath);
    if (!parent) {
      return;
    }

    parent.children = parent.children.filter((child) => child !== file && child.path !== file.path);
  }
}

test("SyncRunLogger buffers multiple log lines into one append", async () => {
  const vault = new MockVault();
  const logPath = "Logs/sync.log";
  vault.files.set(logPath, "# header\n");
  const dialogMessages: string[] = [];
  const logger = new SyncRunLogger(
    {
      vault,
    } as never,
    logPath,
    (message) => dialogMessages.push(message),
  );

  logger.info("First line");
  logger.warn("Second line");
  logger.error("Third line");

  assert.equal(vault.processCalls, 0);

  await logger.flush();

  assert.equal(vault.processCalls, 1);
  assert.deepEqual(dialogMessages, ["First line"]);

  const content = vault.files.get(logPath) ?? "";
  assert.match(content, /\[INFO\] First line/);
  assert.match(content, /\[WARN\] Second line/);
  assert.match(content, /\[ERROR\] Third line/);
  assert.ok(content.indexOf("First line") < content.indexOf("Second line"));
  assert.ok(content.indexOf("Second line") < content.indexOf("Third line"));
});

test("SyncRunLogger can create a missing log file on flush", async () => {
  const vault = new MockVault();
  const logPath = "Logs/new-sync.log";
  const logger = new SyncRunLogger(
    {
      vault,
    } as never,
    logPath,
    () => undefined,
  );

  logger.info("Created on flush");
  await logger.flush();

  assert.equal(vault.createCalls, 1);
  assert.match(vault.files.get(logPath) ?? "", /Created on flush/);
});

test("SyncRunLogger prefixes each message line with its own timestamp and level", async () => {
  const vault = new MockVault();
  const logPath = "Logs/multiline-sync.log";
  const logger = new SyncRunLogger(
    {
      vault,
    } as never,
    logPath,
    () => undefined,
  );

  logger.warn("First line\nSecond line");
  await logger.flush();

  const content = vault.files.get(logPath) ?? "";
  const logLines = content.trim().split("\n");

  assert.equal(logLines.length, 2);
  assert.match(logLines[0] ?? "", /^\[[^\]]+\] \[WARN\] First line$/);
  assert.match(logLines[1] ?? "", /^\[[^\]]+\] \[WARN\] Second line$/);
});

test("cleanupSyncReports removes generated files and can keep the latest 10", async () => {
  const vault = new MockVault();
  vault.addFolder("Imports");
  vault.addFolder("Imports/ChatGPT");
  vault.addFolder("Imports/ChatGPT/sync-result");

  for (let index = 1; index <= 12; index += 1) {
    const padded = String(index).padStart(2, "0");
    await vault.create(`Imports/ChatGPT/sync-result/sync-2026-04-${padded}.md`, `report-${padded}`);
  }

  await vault.create("Imports/ChatGPT/sync-result/readme.md", "keep-me");

  const app = {
    vault,
    fileManager: {
      trashFile: async (file: MockFile) => vault.trashFile(file),
    },
  };

  const keepLatestResult = await cleanupSyncReportFiles(app, "Imports/ChatGPT", "<syncFolder>/sync-result", {
    keepLatest: 10,
  });

  assert.equal(keepLatestResult.reportFolder, "Imports/ChatGPT/sync-result");
  assert.equal(keepLatestResult.removedPaths.length, 2);
  assert.equal(keepLatestResult.keptPaths.length, 10);
  assert.notEqual(vault.getFileByPath("Imports/ChatGPT/sync-result/readme.md"), null);

  const clearAllResult = await cleanupSyncReportFiles(app, "Imports/ChatGPT", "<syncFolder>/sync-result");
  assert.equal(clearAllResult.removedPaths.length, 10);
  assert.equal(clearAllResult.keptPaths.length, 0);
  assert.notEqual(vault.getFileByPath("Imports/ChatGPT/sync-result/readme.md"), null);
});
