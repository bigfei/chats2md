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
const fullwidthBracketFixture = JSON.parse(fs.readFileSync(fullwidthBracketFixturePath, "utf8"));

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
  const detail = parseConversationDetailPayload(
    fullwidthBracketFixture,
    "conversation-fullwidth-brackets",
    {
      title: "Fullwidth Brackets",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  );

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
    "[^1]: [Gist](https://gist.github.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5)",
  ]);
});
