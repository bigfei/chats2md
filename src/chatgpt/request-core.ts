import { raceWithAbort, sleepWithAbort } from "../sync/cancellation";

import type { ChatGptRateLimitMonitor } from "../shared/types";

const MAX_RATE_LIMIT_RETRIES = 3;
const MIN_RATE_LIMIT_BACKOFF_MS = 5000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60000;

export class ChatGptRequestError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(messagePrefix: string, status: number, bodyText: string) {
    super(`${messagePrefix} with HTTP ${status}: ${bodyText}`);
    this.name = "ChatGptRequestError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export interface RequestLikeResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export interface RequestLikeParams {
  url: string;
  method: string;
  headers: Record<string, string>;
  throw: false;
}

export type RequestLikeFn = (params: RequestLikeParams) => Promise<RequestLikeResponse>;

export function isChatGptRequestError(error: unknown): error is ChatGptRequestError {
  return error instanceof ChatGptRequestError;
}

export function isRateLimitedChatGptRequestError(error: unknown): error is ChatGptRequestError {
  return isChatGptRequestError(error) && error.status === 429;
}

function readHeader(headers: unknown, targetName: string): string | null {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return null;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== targetName.toLowerCase()) {
      continue;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function parseRetryAfterMs(raw: string | null): number | null {
  if (!raw) {
    return null;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const retryDate = Date.parse(raw);
  if (!Number.isFinite(retryDate)) {
    return null;
  }

  return Math.max(0, retryDate - Date.now());
}

function computeRateLimitDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(MIN_RATE_LIMIT_BACKOFF_MS, retryAfterMs));
  }

  const baseDelay = Math.min(MAX_RATE_LIMIT_BACKOFF_MS, MIN_RATE_LIMIT_BACKOFF_MS * 2 ** attempt);
  const jitter = Math.round(baseDelay * 0.2 * Math.random());
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, baseDelay + jitter);
}

function readResponseBodyText(response: RequestLikeResponse): string {
  if (typeof response.text === "string" && response.text.trim().length > 0) {
    return response.text;
  }

  const jsonText = JSON.stringify(response.json);
  return typeof jsonText === "string" && jsonText.trim().length > 0 ? jsonText : "No response body.";
}

export async function requestJsonWithRetries(
  requestFn: RequestLikeFn,
  request: RequestLikeParams,
  sleepFn: (ms: number, signal?: AbortSignal) => Promise<void> = sleepWithAbort,
  signal?: AbortSignal,
  rateLimitMonitor?: ChatGptRateLimitMonitor,
): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await raceWithAbort(requestFn(request), signal);

    if (response.status < 400) {
      rateLimitMonitor?.onNonRateLimitedResponse();
      return response.json;
    }

    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      rateLimitMonitor?.onRateLimitedResponse();
      const retryAfterMs = parseRetryAfterMs(readHeader(response.headers, "retry-after"));
      const backoffMs = computeRateLimitDelayMs(attempt, retryAfterMs);
      await sleepFn(backoffMs, signal);
      continue;
    }

    if (response.status === 429) {
      rateLimitMonitor?.onRateLimitedResponse();
    } else {
      rateLimitMonitor?.onNonRateLimitedResponse();
    }

    throw new ChatGptRequestError("ChatGPT request failed", response.status, readResponseBodyText(response));
  }

  throw new Error("ChatGPT request failed after exhausting rate-limit retries.");
}

export async function requestBinary(
  requestFn: RequestLikeFn,
  request: RequestLikeParams,
  signal?: AbortSignal,
  rateLimitMonitor?: ChatGptRateLimitMonitor,
): Promise<{ data: ArrayBuffer; contentType: string | null }> {
  const response = await raceWithAbort(requestFn(request), signal);

  if (response.status >= 400) {
    if (response.status === 429) {
      rateLimitMonitor?.onRateLimitedResponse();
    } else {
      rateLimitMonitor?.onNonRateLimitedResponse();
    }

    throw new ChatGptRequestError("ChatGPT binary request failed", response.status, readResponseBodyText(response));
  }

  rateLimitMonitor?.onNonRateLimitedResponse();

  return {
    data: response.arrayBuffer,
    contentType: readHeader(response.headers, "content-type"),
  };
}
