import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyChatGptContentReferencesAsReferenceLinks,
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
const fullwidthBracketFixturePath = path.join(__dirname, "fixtures", "conversation-detail-fullwidth-brackets.json");
const detailFixture = JSON.parse(fs.readFileSync(detailFixturePath, "utf8"));
const listFixture = JSON.parse(fs.readFileSync(listFixturePath, "utf8"));
const fullwidthBracketFixture = JSON.parse(fs.readFileSync(fullwidthBracketFixturePath, "utf8"));

function collectStringValues(value, output) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringValues(entry, output);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectStringValues(entry, output);
    }
  }
}

function findMessageWithContentReferences(detailPayload) {
  const mapping = detailPayload?.mapping && typeof detailPayload.mapping === "object"
    ? detailPayload.mapping
    : {};

  for (const node of Object.values(mapping)) {
    const message = node?.message;
    const contentReferences = Array.isArray(message?.metadata?.content_references)
      ? message.metadata.content_references
      : [];
    const parts = Array.isArray(message?.content?.parts)
      ? message.content.parts.filter((part) => typeof part === "string")
      : [];

    if (contentReferences.length === 0 || parts.length === 0) {
      continue;
    }

    return {
      text: parts.join("\n"),
      contentReferences
    };
  }

  return null;
}

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

test("applyChatGptContentReferencesAsReferenceLinks preserves fullwidth text", () => {
  const strings = [];
  collectStringValues(fullwidthBracketFixture, strings);

  const fullwidthText = strings.find((value) => value.includes("【】中的文字"));
  assert.ok(fullwidthText, "Fixture must include fullwidth bracket content.");
  assert.match(fullwidthText, /【】中的文字/);
});

test("applyChatGptContentReferencesAsReferenceLinks uses matched_text replacements", () => {
  const message = findMessageWithContentReferences(fullwidthBracketFixture);

  assert.ok(message, "Fixture must include message content references.");

  const { text, references } = applyChatGptContentReferencesAsReferenceLinks(
    message.text,
    message.contentReferences
  );

  assert.match(text, /【文字】/);
  assert.doesNotMatch(text, /(?:cite|filecite)/);
  assert.doesNotMatch(text, /【1†source】/);
  assert.match(text, /\[Gist\]\[ref-\d+-\d+\]/);
  assert.ok(references.length > 0, "Expected generated reference-style links.");
  assert.match(references[0], /^\[ref-\d+-\d+\]: https?:\/\//);
});

test("applyChatGptContentReferencesAsReferenceLinks skips whitespace-only matched_text", () => {
  const { text, references } = applyChatGptContentReferencesAsReferenceLinks(
    "hello world",
    [
      {
        matched_text: " ",
        start_idx: 1,
        end_idx: 2,
        alt: "([Gist](https://example.com))",
        safe_urls: ["https://example.com"]
      }
    ]
  );

  assert.equal(text, "hello world");
  assert.equal(references.length, 0);
});
