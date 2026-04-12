import assert from "node:assert/strict";
import test from "node:test";

import { collectOffsetPaginatedItems } from "../src/index.ts";

test("collectOffsetPaginatedItems dedupes items across pages and keeps preferred items", async () => {
  const pages = new Map<
    number,
    { pageInfo: { limit: number; offset: number; total: number | null }; items: Array<{ id: string; value: string }> }
  >([
    [
      0,
      {
        pageInfo: { limit: 2, offset: 0, total: 3 },
        items: [
          { id: "a", value: "old" },
          { id: "b", value: "keep" },
        ],
      },
    ],
    [
      2,
      {
        pageInfo: { limit: 2, offset: 2, total: 3 },
        items: [
          { id: "a", value: "new" },
          { id: "c", value: "last" },
        ],
      },
    ],
    [
      4,
      {
        pageInfo: { limit: 2, offset: 4, total: 3 },
        items: [],
      },
    ],
  ]);

  const result = await collectOffsetPaginatedItems(
    async (offset) => {
      const page = pages.get(offset);
      assert.ok(page);
      return page;
    },
    {
      pageLimit: 2,
      parallelism: 2,
      getItemId: (item) => item.id,
      mergeItem: (_existing, candidate) => candidate,
      sortItems: (items) => items.sort((left, right) => left.id.localeCompare(right.id)),
      shouldContinue: (page) => page.items.length >= page.pageInfo.limit,
      getNextOffset: (offset, page) => offset + page.pageInfo.limit,
    },
  );

  assert.equal(result.pagesFetched, 3);
  assert.equal(result.rawItemCount, 4);
  assert.equal(result.uniqueItemCount, 3);
  assert.deepEqual(result.items, [
    { id: "a", value: "new" },
    { id: "b", value: "keep" },
    { id: "c", value: "last" },
  ]);
});
