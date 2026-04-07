import assert from "node:assert/strict";
import test from "node:test";

import { requestBinary, requestJsonWithRetries } from "../src/chatgpt/request-core.ts";

test("requestJsonWithRetries sets throw=false and retries after HTTP 429", async () => {
  const calls: Array<{ url: string; method: string; throw: boolean }> = [];
  const delays: number[] = [];
  let attempt = 0;

  const payload = await requestJsonWithRetries(
    async (params) => {
      calls.push({ url: params.url, method: params.method, throw: params.throw });
      attempt += 1;

      if (attempt === 1) {
        return {
          status: 429,
          headers: { "retry-after": "0" },
          arrayBuffer: new ArrayBuffer(0),
          json: { error: "rate_limited" },
          text: '{"error":"rate_limited"}',
        };
      }

      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { items: [] },
        text: '{"items":[]}',
      };
    },
    {
      url: "https://chatgpt.com/backend-api/conversations?offset=0&limit=100",
      method: "GET",
      headers: {},
      throw: false,
    },
    async (ms) => {
      delays.push(ms);
    },
  );

  assert.deepEqual(payload, { items: [] });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.throw === false));
  assert.equal(delays.length, 1);
  assert.ok((delays[0] ?? 0) >= 5000);
  assert.ok((delays[0] ?? 0) <= 6000);
});

test("requestJsonWithRetries reports rate-limited and successful responses to the monitor", async () => {
  const events: string[] = [];
  let attempt = 0;

  const payload = await requestJsonWithRetries(
    async () => {
      attempt += 1;

      if (attempt === 1) {
        return {
          status: 429,
          headers: { "retry-after": "0" },
          arrayBuffer: new ArrayBuffer(0),
          json: { error: "rate_limited" },
          text: '{"error":"rate_limited"}',
        };
      }

      return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { items: ["ok"] },
        text: '{"items":["ok"]}',
      };
    },
    {
      url: "https://chatgpt.com/backend-api/conversations?offset=0&limit=100",
      method: "GET",
      headers: {},
      throw: false,
    },
    async () => {},
    undefined,
    {
      onRateLimitedResponse: () => {
        events.push("rate-limited");
      },
      onNonRateLimitedResponse: () => {
        events.push("ok");
      },
    },
  );

  assert.deepEqual(payload, { items: ["ok"] });
  assert.deepEqual(events, ["rate-limited", "ok"]);
});

test("requestBinary sets throw=false for binary downloads", async () => {
  const calls: Array<{ url: string; method: string; throw: boolean; headers: Record<string, string> }> = [];
  const arrayBuffer = Uint8Array.from([1, 2, 3]).buffer;

  const result = await requestBinary(
    async (params) => {
      calls.push({ url: params.url, method: params.method, throw: params.throw, headers: params.headers });
      return {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        arrayBuffer,
        json: {},
        text: "",
      };
    },
    {
      url: "https://chatgpt.com/files/test.bin",
      method: "GET",
      headers: { Accept: "*/*" },
      throw: false,
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.throw, false);
  assert.equal(result.contentType, "application/octet-stream");
  assert.equal(result.data.byteLength, 3);
});

test("requestBinary reports 429 failures to the monitor", async () => {
  const events: string[] = [];

  await assert.rejects(
    requestBinary(
      async () => ({
        status: 429,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        json: { error: "rate_limited" },
        text: '{"error":"rate_limited"}',
      }),
      {
        url: "https://chatgpt.com/files/test.bin",
        method: "GET",
        headers: { Accept: "*/*" },
        throw: false,
      },
      undefined,
      {
        onRateLimitedResponse: () => {
          events.push("rate-limited");
        },
        onNonRateLimitedResponse: () => {
          events.push("ok");
        },
      },
    ),
    /HTTP 429/,
  );

  assert.deepEqual(events, ["rate-limited"]);
});
