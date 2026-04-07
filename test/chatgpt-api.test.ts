import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFileDownloadInfo } from "../src/chatgpt/file-download-info.ts";

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
