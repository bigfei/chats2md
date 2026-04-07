import { raceWithAbort, sleepWithAbort } from "../sync/cancellation";

const MAX_RATE_LIMIT_RETRIES = 3;
const MIN_RATE_LIMIT_BACKOFF_MS = 5000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60000;

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

export async function requestJsonWithRetries(
  requestFn: RequestLikeFn,
  request: RequestLikeParams,
  sleepFn: (ms: number, signal?: AbortSignal) => Promise<void> = sleepWithAbort,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await raceWithAbort(requestFn(request), signal);

    if (response.status < 400) {
      return response.json;
    }

    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterMs = parseRetryAfterMs(readHeader(response.headers, "retry-after"));
      const backoffMs = computeRateLimitDelayMs(attempt, retryAfterMs);
      await sleepFn(backoffMs, signal);
      continue;
    }

    const bodyText =
      typeof response.text === "string" && response.text.trim().length > 0
        ? response.text
        : JSON.stringify(response.json);

    throw new Error(`ChatGPT request failed with HTTP ${response.status}: ${bodyText}`);
  }

  throw new Error("ChatGPT request failed after exhausting rate-limit retries.");
}

export async function requestBinary(
  requestFn: RequestLikeFn,
  request: RequestLikeParams,
  signal?: AbortSignal,
): Promise<{ data: ArrayBuffer; contentType: string | null }> {
  const response = await raceWithAbort(requestFn(request), signal);

  if (response.status >= 400) {
    const bodyText =
      typeof response.text === "string" && response.text.trim().length > 0
        ? response.text
        : JSON.stringify(response.json);
    throw new Error(`ChatGPT binary request failed with HTTP ${response.status}: ${bodyText}`);
  }

  return {
    data: response.arrayBuffer,
    contentType: readHeader(response.headers, "content-type"),
  };
}
