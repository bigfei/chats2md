import assert from "node:assert/strict";
import test from "node:test";

import { buildStableAssetFileName, findReusableLocalAssetFileName } from "../src/main/asset-local-match.ts";

test("findReusableLocalAssetFileName prefers a fileId-based local asset", () => {
  const fileName = findReusableLocalAssetFileName(["file_00000000725461fa9cc192120f070b8b.png"], {
    fileId: "file_00000000725461fa9cc192120f070b8b",
    logicalName: "1000029296.jpg",
  });

  assert.equal(fileName, "file_00000000725461fa9cc192120f070b8b.png");
});

test("buildStableAssetFileName uses the fileId and preserves an inferred extension", () => {
  const fileName = buildStableAssetFileName("file_123", "image.png", "image.png");

  assert.equal(fileName, "file_123.png");
});

test("findReusableLocalAssetFileName does not reuse a logical-name-only asset for a different fileId", () => {
  const fileName = findReusableLocalAssetFileName(["image.png"], {
    fileId: "file_123",
    logicalName: "image.png",
  });

  assert.equal(fileName, null);
});

test("findReusableLocalAssetFileName returns null when no local asset matches", () => {
  const fileName = findReusableLocalAssetFileName(["other.png"], {
    fileId: "file_123",
    logicalName: "image.png",
  });

  assert.equal(fileName, null);
});
