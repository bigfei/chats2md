import assert from "node:assert/strict";
import test from "node:test";

import { buildAuthHeaders, createFetchTransport, resolveAuthProvider } from "../src/index.ts";

test("buildAuthHeaders merges headers, bearer auth, and cookies", () => {
  const headers = buildAuthHeaders(
    {
      Accept: "application/json",
      Cookie: "existing=1",
    },
    {
      headers: {
        "X-Test": "yes",
      },
      bearerToken: "token-123",
      cookie: "session=abc",
    },
  );

  assert.deepEqual(headers, {
    Accept: "application/json",
    Authorization: "Bearer token-123",
    Cookie: "existing=1; session=abc",
    "X-Test": "yes",
  });
});

test("resolveAuthProvider supports dynamic auth builders", async () => {
  const auth = await resolveAuthProvider(
    async (context) => ({
      headers: {
        "X-Url": context.url,
      },
      cookie: "session=dynamic",
    }),
    {
      url: "https://example.test/items",
      method: "GET",
      headers: {},
    },
  );

  assert.deepEqual(auth, {
    headers: {
      "X-Url": "https://example.test/items",
    },
    cookie: "session=dynamic",
  });
});

test("createFetchTransport applies auth to outgoing requests", async () => {
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const transport = createFetchTransport(async (_input, init) => {
    requests.push({
      url: String(_input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });

    return new Response('{"ok":true}', {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  });

  const response = await transport({
    url: "https://example.test/items",
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    auth: {
      bearerToken: "token-123",
      cookie: "session=abc",
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true });
  assert.deepEqual(requests, [
    {
      url: "https://example.test/items",
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer token-123",
        Cookie: "session=abc",
      },
    },
  ]);
});
