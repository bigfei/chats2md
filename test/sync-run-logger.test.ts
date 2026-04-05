import assert from "node:assert/strict";
import test from "node:test";

import { SyncRunLogger } from "../src/main/helpers.ts";

interface MockFile {
  path: string;
}

class MockVault {
  readonly files = new Map<string, string>();
  createCalls = 0;
  processCalls = 0;

  getFileByPath(path: string): MockFile | null {
    return this.files.has(path) ? { path } : null;
  }

  getAbstractFileByPath(path: string): MockFile | null {
    return this.getFileByPath(path);
  }

  async create(path: string, content: string): Promise<MockFile> {
    this.createCalls += 1;
    this.files.set(path, content);
    return { path };
  }

  async process(file: MockFile, fn: (content: string) => string): Promise<void> {
    this.processCalls += 1;
    const existing = this.files.get(file.path);

    if (typeof existing !== "string") {
      throw new Error(`Missing file: ${file.path}`);
    }

    this.files.set(file.path, fn(existing));
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
