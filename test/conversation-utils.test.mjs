import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractConversationListPageInfo,
  getNextConversationListOffset,
  getDateBucketFromTimestamp,
  normalizeConversationTimestamp,
  shouldFetchNextConversationListPage,
  slugifyConversationTitle
} from "../src/conversation-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const detailFixturePath = path.join(__dirname, "fixtures", "conversation-detail-chinese-title.json");
const listFixturePath = path.join(__dirname, "fixtures", "conversation-list.json");
const detailFixture = JSON.parse(fs.readFileSync(detailFixturePath, "utf8"));
const listFixture = JSON.parse(fs.readFileSync(listFixturePath, "utf8"));

test("slugifyConversationTitle keeps Chinese titles", () => {
  const slug = slugifyConversationTitle(detailFixture.title);

  assert.equal(slug, "运放电路分析");
  assert.notEqual(slug, "untitled-conversation");
});

test("normalizeConversationTimestamp handles numeric seconds", () => {
  const createdAt = normalizeConversationTimestamp(detailFixture.create_time);
  const updatedAt = normalizeConversationTimestamp(detailFixture.update_time);

  assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("getDateBucketFromTimestamp returns YYYY-MM-DD", () => {
  const updatedAt = normalizeConversationTimestamp(detailFixture.update_time);
  const bucket = getDateBucketFromTimestamp(updatedAt);

  assert.match(bucket, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(bucket, updatedAt.slice(0, 10));
});

test("extractConversationListPageInfo reads response limit metadata", () => {
  const pageInfo = extractConversationListPageInfo(listFixture);

  assert.equal(pageInfo.limit, 28);
  assert.equal(pageInfo.offset, 0);
  assert.equal(pageInfo.total, 29);
});

test("conversation list pagination follows API limit metadata", () => {
  const pageInfo = extractConversationListPageInfo({
    limit: 28,
    offset: 56,
    total: 120
  }, 50);

  assert.equal(shouldFetchNextConversationListPage(28, pageInfo, 50), true);
  assert.equal(getNextConversationListOffset(56, pageInfo, 50), 84);
});
