import assert from "node:assert/strict";
import test from "node:test";

import { findReusableLocalAssetFileName } from "../src/main/asset-local-match.ts";

test("findReusableLocalAssetFileName prefers a fileId-based local asset", () => {
  const fileName = findReusableLocalAssetFileName(["file_00000000725461fa9cc192120f070b8b.png"], {
    fileId: "file_00000000725461fa9cc192120f070b8b",
    logicalName: "1000029296.jpg",
  });

  assert.equal(fileName, "file_00000000725461fa9cc192120f070b8b.png");
});

test("findReusableLocalAssetFileName falls back to the logical local file name", () => {
  const fileName = findReusableLocalAssetFileName(["image.png"], {
    fileId: "file_123",
    logicalName: "image.png",
  });

  assert.equal(fileName, "image.png");
});

test("findReusableLocalAssetFileName returns null when no local asset matches", () => {
  const fileName = findReusableLocalAssetFileName(["other.png"], {
    fileId: "file_123",
    logicalName: "image.png",
  });

  assert.equal(fileName, null);
});
