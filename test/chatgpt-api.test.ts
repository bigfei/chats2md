import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseConversationDetailPayload } from "../src/chatgpt/api.ts";
import { normalizeFileDownloadInfo } from "../src/chatgpt/file-download-info.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fullwidthBracketFixturePath = path.join(__dirname, "fixtures", "conversation-detail-fullwidth-brackets.json");
const fullMediaFixturePath = path.join(__dirname, "fixtures", "full-media.json");
const enterpriseEditionFixturePath = path.join(__dirname, "fixtures", "enterprise-edition.json");
const fullwidthBracketFixture = JSON.parse(fs.readFileSync(fullwidthBracketFixturePath, "utf8"));
const fullMediaFixture = JSON.parse(fs.readFileSync(fullMediaFixturePath, "utf8"));
const enterpriseEditionFixture = JSON.parse(fs.readFileSync(enterpriseEditionFixturePath, "utf8"));

test("normalizeFileDownloadInfo returns download metadata when download_url is present", () => {
  const result = normalizeFileDownloadInfo(
    {
      download_url: "https://files.example.test/download",
      file_name: "劳动合同.pdf",
    },
    "file-123",
  );

  assert.deepEqual(result, {
    downloadUrl: "https://files.example.test/download",
    fileName: "劳动合同.pdf",
  });
});

test("normalizeFileDownloadInfo surfaces application-level backend errors", () => {
  assert.throws(
    () =>
      normalizeFileDownloadInfo(
        {
          status: "error",
          error_code: "file_not_found",
          error_type: "GetDownloadLinkError",
          error_message: null,
        },
        "file-pA24d6fd9UwdMkXRNUWfluCI",
      ),
    /status=error, error_code=file_not_found, error_type=GetDownloadLinkError/,
  );
});

test("normalizeFileDownloadInfo keeps the generic missing download_url error for malformed payloads", () => {
  assert.throws(
    () =>
      normalizeFileDownloadInfo(
        {
          file_name: "劳动合同.pdf",
        },
        "file-123",
      ),
    /missing download_url/,
  );
});

test("parseConversationDetailPayload emits whole-note deduped footnotes", () => {
  const detail = parseConversationDetailPayload(fullwidthBracketFixture, "conversation-fullwidth-brackets", {
    title: "Fullwidth Brackets",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const assistantMessages = detail.messages.filter((message) => message.role === "assistant");
  assert.ok(assistantMessages.length > 0);

  const joinedAssistantMarkdown = assistantMessages.map((message) => message.markdown).join("\n\n");
  assert.match(joinedAssistantMarkdown, /\[\^1\]/);
  assert.doesNotMatch(joinedAssistantMarkdown, /\[ref-/);
  assert.doesNotMatch(joinedAssistantMarkdown, /(?:cite|filecite)/);

  assert.ok(Array.isArray(detail.footnotes));
  assert.ok(detail.footnotes.length > 0);
  assert.equal(detail.footnotes.length, 1);
  assert.deepEqual(detail.footnotes, [
    "[^1]: [ChatGPT Conversation Exporter — export all your conversations as JSON + Markdown + ZIP. No dependencies beyond bash, curl, python3. · GitHub](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5)",
  ]);
});

test("parseConversationDetailPayload converts ChatGPT content references into Obsidian-friendly markdown", () => {
  const detail = parseConversationDetailPayload(fullMediaFixture, "full-media", {
    title: "Obsidian Citation Setup",
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:00.000Z",
  });

  const assistantMessage = detail.messages.find((message) => message.id === "79abff3b-45f2-418d-906e-82c8ceb61810");
  assert.ok(assistantMessage);

  assert.match(assistantMessage.markdown, /Using the \*\*<u>Citations plugin for Obsidian<\/u>\*\*/);
  assert.match(assistantMessage.markdown, /This is a \*\*Pandoc-style citation\*\*.*\[\^1\]/s);
  assert.match(assistantMessage.markdown, /exported from <u>Zotero<\/u>/);
  assert.match(
    assistantMessage.markdown,
    /Obsidian \+ Zotero citations workflow tutorial\n!\[]\(https:\/\/www\.youtube\.com\/watch\?v=fTb3pwn54X8&utm_source=chatgpt\.com\)/,
  );
  assert.doesNotMatch(assistantMessage.markdown, /(?:cite|entity|video)/);
  assert.doesNotMatch(assistantMessage.markdown, /\*\*\*\*/);
  assert.doesNotMatch(assistantMessage.markdown, /img\.youtube\.com/);

  assert.deepEqual(detail.footnotes, [
    "[^1]: [Obsidian Vault](https://ktmeaton.github.io/obsidian-site/obsidian-site/notes/Obsidian-Citations?utm_source=chatgpt.com)",
    "[^2]: [Citations | SimilarPlugins](https://plugins.semiautonomous.org/plugin/obsidian-citation-plugin?utm_source=chatgpt.com)",
  ]);
});

test("parseConversationDetailPayload uses matched item titles for grouped webpage footnotes", () => {
  const detail = parseConversationDetailPayload(enterpriseEditionFixture, "enterprise-edition", {
    title: "Enterprise Edition",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  });

  assert.ok(detail.footnotes.length > 0);
  assert.equal(detail.footnotes[0], "[^1]: [AI Agents – Linear Docs](https://linear.app/docs/agents-in-linear)");
});
