import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyChatGptContentReferencesAsFootnotes,
  createConversationFootnoteRegistry,
  finalizeConversationFootnoteText,
  extractConversationListPageInfo,
  getConversationFootnoteDefinitions,
  getNextConversationListOffset,
  getDateBucketFromTimestamp,
  normalizeConversationTimestamp,
  shouldFetchNextConversationListPage,
  slugifyConversationTitle,
} from "../src/chatgpt/conversation-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const detailFixturePath = path.join(__dirname, "fixtures", "conversation-detail-chinese-title.json");
const listFixturePath = path.join(__dirname, "fixtures", "conversation-list.json");
const fullwidthBracketFixturePath = path.join(__dirname, "fixtures", "conversation-detail-fullwidth-brackets.json");
const fullMediaFixturePath = path.join(__dirname, "fixtures", "full-media.json");
const enterpriseEditionFixturePath = path.join(__dirname, "fixtures", "enterprise-edition.json");
const detailFixture = JSON.parse(fs.readFileSync(detailFixturePath, "utf8"));
const listFixture = JSON.parse(fs.readFileSync(listFixturePath, "utf8"));
const fullwidthBracketFixture = JSON.parse(fs.readFileSync(fullwidthBracketFixturePath, "utf8"));
const fullMediaFixture = JSON.parse(fs.readFileSync(fullMediaFixturePath, "utf8"));
const enterpriseEditionFixture = JSON.parse(fs.readFileSync(enterpriseEditionFixturePath, "utf8"));

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
  const mapping = detailPayload?.mapping && typeof detailPayload.mapping === "object" ? detailPayload.mapping : {};

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
      contentReferences,
    };
  }

  return null;
}

function findMessageById(detailPayload, messageId) {
  const mapping = detailPayload?.mapping && typeof detailPayload.mapping === "object" ? detailPayload.mapping : {};
  const node = mapping[messageId];
  const message = node?.message;
  const contentReferences = Array.isArray(message?.metadata?.content_references)
    ? message.metadata.content_references
    : [];
  const parts = Array.isArray(message?.content?.parts)
    ? message.content.parts.filter((part) => typeof part === "string")
    : [];

  if (!message || parts.length === 0) {
    return null;
  }

  return {
    text: parts.join("\n"),
    contentReferences,
  };
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
  const pageInfo = extractConversationListPageInfo(
    {
      limit: 28,
      offset: 56,
      total: 120,
    },
    50,
  );

  assert.equal(shouldFetchNextConversationListPage(28, pageInfo, 50), true);
  assert.equal(getNextConversationListOffset(56, pageInfo, 50), 84);
});

test("applyChatGptContentReferencesAsFootnotes preserves fullwidth text", () => {
  const strings = [];
  collectStringValues(fullwidthBracketFixture, strings);

  const fullwidthText = strings.find((value) => value.includes("【】中的文字"));
  assert.ok(fullwidthText, "Fixture must include fullwidth bracket content.");
  assert.match(fullwidthText, /【】中的文字/);
});

test("applyChatGptContentReferencesAsFootnotes uses matched_text replacements", () => {
  const message = findMessageWithContentReferences(fullwidthBracketFixture);

  assert.ok(message, "Fixture must include message content references.");

  const { text, footnotes } = applyChatGptContentReferencesAsFootnotes(message.text, message.contentReferences);

  assert.match(text, /【文字】/);
  assert.doesNotMatch(text, /(?:cite|filecite)/);
  assert.doesNotMatch(text, /【1†source】/);
  assert.match(text, /\[\^\d+(?:-\d+)?\]/);
  assert.ok(footnotes.length > 0, "Expected generated footnote definitions.");
  assert.match(footnotes[0], /^\[\^\d+(?:-\d+)?\]: \[[^\]]+\]\(https?:\/\//);
});

test("applyChatGptContentReferencesAsFootnotes skips whitespace-only matched_text", () => {
  const { text, footnotes } = applyChatGptContentReferencesAsFootnotes("hello world", [
    {
      matched_text: " ",
      start_idx: 1,
      end_idx: 2,
      alt: "([Gist](https://example.com))",
      safe_urls: ["https://example.com"],
    },
  ]);

  assert.equal(text, "hello world");
  assert.equal(footnotes.length, 0);
});

test("applyChatGptContentReferencesAsFootnotes suffixes duplicate URLs across calls", () => {
  const registry = createConversationFootnoteRegistry();
  const repeatedReferences = [
    {
      matched_text: "citeturnAsearch0",
      alt: "([Gist](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5))",
      safe_urls: ["https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5"],
    },
  ];

  const first = applyChatGptContentReferencesAsFootnotes("first citeturnAsearch0", repeatedReferences, registry, {
    finalizeText: false,
  });
  const second = applyChatGptContentReferencesAsFootnotes("second citeturnAsearch0", repeatedReferences, registry, {
    finalizeText: false,
  });

  assert.equal(finalizeConversationFootnoteText(first.text, registry), "first [^1-1]");
  assert.equal(finalizeConversationFootnoteText(second.text, registry), "second [^1-2]");

  const footnotes = getConversationFootnoteDefinitions(registry);
  assert.equal(footnotes.length, 2);
  assert.equal(footnotes[0], "[^1-1]: [Gist](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5)");
  assert.equal(footnotes[1], "[^1-2]: [Gist](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5)");
});

test("applyChatGptContentReferencesAsFootnotes prefers the matched item title over alt text", () => {
  const message = findMessageWithContentReferences(fullwidthBracketFixture);

  assert.ok(message, "Fixture must include message content references.");

  const { footnotes } = applyChatGptContentReferencesAsFootnotes(message.text, message.contentReferences);

  assert.equal(
    footnotes[0],
    "[^1-1]: [ChatGPT Conversation Exporter — export all your conversations as JSON + Markdown + ZIP. No dependencies beyond bash, curl, python3. · GitHub](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5)",
  );
});

test("applyChatGptContentReferencesAsFootnotes retroactively renames the first duplicate URL within one message", () => {
  const repeatedReferences = [
    {
      matched_text: "citeturnAsearch0",
      alt: "([Gist](https://example.com))",
      safe_urls: ["https://example.com"],
      items: [{ title: "Example", url: "https://example.com" }],
      start_idx: 0,
    },
    {
      matched_text: "citeturnAsearch1",
      alt: "([Gist](https://example.com))",
      safe_urls: ["https://example.com"],
      items: [{ title: "Example", url: "https://example.com" }],
      start_idx: 10,
    },
  ];

  const result = applyChatGptContentReferencesAsFootnotes(
    "first citeturnAsearch0 second citeturnAsearch1",
    repeatedReferences,
  );

  assert.equal(result.text, "first [^1-1] second [^1-2]");
  assert.deepEqual(result.footnotes, [
    "[^1-1]: [Example](https://example.com)",
    "[^1-2]: [Example](https://example.com)",
  ]);
});

test("applyChatGptContentReferencesAsFootnotes does not emit dangling definition when marker is missing", () => {
  const { text, footnotes } = applyChatGptContentReferencesAsFootnotes("plain text", [
    {
      matched_text: "citeturnAsearch0",
      alt: "([Gist](https://example.com))",
      safe_urls: ["https://example.com"],
    },
  ]);

  assert.equal(text, "plain text");
  assert.equal(footnotes.length, 0);
});

test("applyChatGptContentReferencesAsFootnotes renders ChatGPT entity refs as underlined text and webpage refs as footnotes", () => {
  const message = findMessageById(fullMediaFixture, "79abff3b-45f2-418d-906e-82c8ceb61810");

  assert.ok(message, "Fixture must include the cited assistant message.");

  const { text, footnotes } = applyChatGptContentReferencesAsFootnotes(message.text, message.contentReferences);

  assert.match(text, /Using the \*\*<u>Citations plugin for Obsidian<\/u>\*\*/);
  assert.match(text, /exported from <u>Zotero<\/u>/);
  assert.match(text, /using \*\*<u>Pandoc<\/u>\*\*/);
  assert.doesNotMatch(text, /(?:cite|entity|video)/);
  assert.match(text, /The plugin inserts it directly into your note \[\^1\]/);
  assert.match(text, /Works with `\.bib` or JSON exports \[\^2-2\]/);
  assert.equal(footnotes.length, 3);
  assert.equal(
    footnotes[0],
    "[^1]: [Obsidian Vault](https://ktmeaton.github.io/obsidian-site/obsidian-site/notes/Obsidian-Citations?utm_source=chatgpt.com)",
  );
  assert.equal(
    footnotes[1],
    "[^2-1]: [Citations | SimilarPlugins](https://plugins.semiautonomous.org/plugin/obsidian-citation-plugin?utm_source=chatgpt.com)",
  );
  assert.equal(
    footnotes[2],
    "[^2-2]: [Citations | SimilarPlugins](https://plugins.semiautonomous.org/plugin/obsidian-citation-plugin?utm_source=chatgpt.com)",
  );
});

test("applyChatGptContentReferencesAsFootnotes uses the matched item title for grouped webpage footnotes", () => {
  const message = findMessageById(enterpriseEditionFixture, "749c40d8-61e4-4d99-bcef-ece15d41280b");

  assert.ok(message, "Fixture must include the enterprise comparison assistant message.");

  const { footnotes } = applyChatGptContentReferencesAsFootnotes(message.text, message.contentReferences);

  assert.ok(footnotes.length > 0);
  assert.equal(footnotes[0], "[^1-1]: [AI Agents – Linear Docs](https://linear.app/docs/agents-in-linear)");
});

test("applyChatGptContentReferencesAsFootnotes renders ChatGPT video refs as Obsidian embeds", () => {
  const message = findMessageById(fullMediaFixture, "79abff3b-45f2-418d-906e-82c8ceb61810");

  assert.ok(message, "Fixture must include the cited assistant message.");

  const { text } = applyChatGptContentReferencesAsFootnotes(message.text, message.contentReferences);

  assert.match(
    text,
    /Obsidian \+ Zotero citations workflow tutorial\n!\[]\(https:\/\/www\.youtube\.com\/watch\?v=fTb3pwn54X8&utm_source=chatgpt\.com\)/,
  );
  assert.doesNotMatch(text, /img\.youtube\.com/);
});
