import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  normalizeObsidianMathDelimiters,
  parseConversationDetailPayload,
  parseSessionJson,
} from "../src/chatgpt/api.ts";
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
  assert.match(joinedAssistantMarkdown, /\[\^1-1\]/);
  assert.match(joinedAssistantMarkdown, /\[\^1-4\]/);
  assert.doesNotMatch(joinedAssistantMarkdown, /\[ref-/);
  assert.doesNotMatch(joinedAssistantMarkdown, /(?:cite|filecite)/);

  assert.ok(Array.isArray(detail.footnotes));
  assert.ok(detail.footnotes.length > 0);
  assert.equal(detail.footnotes.length, 4);
  assert.deepEqual(detail.footnotes, [
    "[^1-1]: [ChatGPT Conversation Exporter — export all your conversations as JSON + Markdown + ZIP. No dependencies beyond bash, curl, python3. · GitHub](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5)",
    "[^1-2]: [ChatGPT Conversation Exporter — export all your conversations as JSON + Markdown + ZIP. No dependencies beyond bash, curl, python3. · GitHub](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5)",
    "[^1-3]: [ChatGPT Conversation Exporter — export all your conversations as JSON + Markdown + ZIP. No dependencies beyond bash, curl, python3. · GitHub](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5)",
    "[^1-4]: [ChatGPT Conversation Exporter — export all your conversations as JSON + Markdown + ZIP. No dependencies beyond bash, curl, python3. · GitHub](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5)",
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
  assert.match(assistantMessage.markdown, /\[\^2-1\]/);
  assert.match(assistantMessage.markdown, /\[\^2-2\]/);

  assert.deepEqual(detail.footnotes, [
    "[^1]: [Obsidian Vault](https://ktmeaton.github.io/obsidian-site/obsidian-site/notes/Obsidian-Citations?utm_source=chatgpt.com)",
    "[^2-1]: [Citations | SimilarPlugins](https://plugins.semiautonomous.org/plugin/obsidian-citation-plugin?utm_source=chatgpt.com)",
    "[^2-2]: [Citations | SimilarPlugins](https://plugins.semiautonomous.org/plugin/obsidian-citation-plugin?utm_source=chatgpt.com)",
  ]);
});

test("parseConversationDetailPayload uses matched item titles for grouped webpage footnotes", () => {
  const detail = parseConversationDetailPayload(enterpriseEditionFixture, "enterprise-edition", {
    title: "Enterprise Edition",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
  });

  assert.ok(detail.footnotes.length > 0);
  assert.equal(detail.footnotes[0], "[^1-1]: [AI Agents – Linear Docs](https://linear.app/docs/agents-in-linear)");
});

test("normalizeObsidianMathDelimiters converts escaped inline and block math", () => {
  assert.equal(
    normalizeObsidianMathDelimiters("Inline: \\( x + y \\)\n\nBlock:\n\\[\n  x^2 + y^2\n\\]"),
    "Inline: $x + y$\n\nBlock:\n$$\nx^2 + y^2\n$$",
  );
});

test("parseSessionJson strips reserved headers and falls back to cookie headers", () => {
  const config = parseSessionJson(
    JSON.stringify({
      accessToken: "token-123",
      account: { id: "account-123" },
      user: { id: "user-123", email: "user@example.com" },
      expires: "2026-04-09T00:00:00.000Z",
      headers: {
        Cookie: "session=value",
        Accept: "text/plain",
        Authorization: "ignored",
        "X-Custom-Header": "kept",
      },
    }),
    "1.2.3",
  );

  assert.equal(config.accessToken, "token-123");
  assert.equal(config.accountId, "account-123");
  assert.equal(config.userId, "user-123");
  assert.equal(config.userEmail, "user@example.com");
  assert.equal(config.cookie, "session=value");
  assert.equal(config.userAgent.includes("chats2md/1.2.3"), true);
  assert.deepEqual(config.headers, {
    "X-Custom-Header": "kept",
  });
});

test("parseSessionJson rejects invalid JSON and missing required fields", () => {
  assert.throws(() => parseSessionJson("{"), /Invalid session JSON/);
  assert.throws(
    () =>
      parseSessionJson(
        JSON.stringify({
          account: { id: "account-123" },
        }),
      ),
    /Missing accessToken/,
  );
  assert.throws(
    () =>
      parseSessionJson(
        JSON.stringify({
          accessToken: "token-123",
        }),
      ),
    /Missing account.id/,
  );
});

test("parseConversationDetailPayload renders mixed content types and metadata placeholders", () => {
  const detail = parseConversationDetailPayload(
    {
      title: "Renderer coverage",
      create_time: 1712620800,
      update_time: 1712707200,
      current_node: "assistant-tool",
      mapping: {
        root: {
          id: "root",
          parent: null,
          message: {
            id: "user-message",
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: ["User prompt"],
            },
          },
        },
        "assistant-code": {
          id: "assistant-code",
          parent: "root",
          message: {
            id: "assistant-code-message",
            author: { role: "assistant" },
            content: {
              content_type: "code",
              language: "ts",
              text: "const answer = 42;",
            },
            metadata: {
              attachments: [
                { id: "file-1", name: "notes.txt" },
                { id: "file-1", name: "notes.txt" },
              ],
              citations: [
                { metadata: { file_id: "citation-1", title: "API spec" } },
                { file_id: "citation-1", title: "API spec" },
              ],
            },
          },
        },
        "assistant-thoughts": {
          id: "assistant-thoughts",
          parent: "assistant-code",
          message: {
            author: { role: "assistant" },
            content: {
              content_type: "thoughts",
              thoughts: [
                { summary: "Plan", content: "Think step by step" },
                { summary: "Empty", content: "" },
              ],
            },
          },
        },
        "assistant-tool": {
          id: "assistant-tool",
          parent: "assistant-thoughts",
          message: {
            id: "assistant-tool-message",
            author: { role: "tool", name: "browser" },
            content: {
              content_type: "tether_quote",
              title: "Quoted page",
              url: "https://example.test/page",
              text: "Quoted body",
            },
          },
        },
      },
    },
    "conversation-renderers",
  );

  assert.equal(detail.id, "conversation-renderers");
  assert.equal(detail.messages[0]?.markdown, "## user\n\n> User prompt");
  assert.match(detail.messages[1]?.markdown ?? "", /```ts\nconst answer = 42;\n```/);
  assert.match(detail.messages[1]?.markdown ?? "", /Attachment: \[\[chats2md:attachment:file-1\]\]/);
  assert.match(detail.messages[1]?.markdown ?? "", /Citation: \[\[chats2md:citation:citation-1\]\]/);
  assert.match(detail.messages[2]?.markdown ?? "", /##### Plan\n\nThink step by step/);
  assert.match(detail.messages[3]?.markdown ?? "", /^## tool \(browser\)\n\n> > Quoted page/s);
  assert.deepEqual(detail.fileReferences, [
    {
      fileId: "file-1",
      kind: "attachment",
      logicalName: "notes.txt",
      placeholder: "[[chats2md:attachment:file-1]]",
    },
    {
      fileId: "citation-1",
      kind: "citation",
      logicalName: "API spec",
      placeholder: "[[chats2md:citation:citation-1]]",
    },
  ]);
});

test("parseConversationDetailPayload falls back to node ids and handles mapping cycles", () => {
  const detail = parseConversationDetailPayload(
    {
      current_node: "assistant",
      mapping: {
        root: {
          parent: "assistant",
          message: {
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: ["Hello"],
            },
          },
        },
        assistant: {
          parent: "root",
          message: {
            author: { role: "assistant" },
            content: {
              content_type: "reasoning_recap",
              content: "Summary",
            },
          },
        },
      },
    },
    "conversation-cycle",
    {
      title: "Fallback title",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-02T00:00:00.000Z",
    },
  );

  assert.equal(detail.title, "Fallback title");
  assert.equal(detail.messages[0]?.id, "root");
  assert.equal(detail.messages[1]?.id, "assistant");
  assert.match(detail.messages[1]?.markdown ?? "", /^## assistant\n\n> Summary$/);
});

test("parseConversationDetailPayload rejects payloads without mapping or current node", () => {
  assert.throws(() => parseConversationDetailPayload({}, "conversation-missing"), /mapping\/current_node/);
});
