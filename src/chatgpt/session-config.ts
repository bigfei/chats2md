import type { ChatGptRequestConfig } from "../shared/types";

const DEFAULT_FIREFOX_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0";
const RESERVED_HEADER_NAMES = new Set(["accept", "authorization", "chatgpt-account-id", "cookie", "user-agent"]);

interface SessionPayload {
  accessToken?: string;
  cookie?: string;
  expires?: string;
  headers?: Record<string, unknown>;
  user?: {
    id?: string;
    email?: string;
  };
  account?: {
    id?: string;
  };
}

type UnknownRecord = Record<string, unknown>;

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function toRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function parseCustomHeaders(value: unknown): Record<string, string> {
  const record = toRecord(value);

  if (!record) {
    return {};
  }

  const headers: Record<string, string> = {};

  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }

    const headerValue = record[key];
    if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
      continue;
    }

    if (RESERVED_HEADER_NAMES.has(key.toLowerCase())) {
      continue;
    }

    headers[key] = headerValue;
  }

  return headers;
}

export function normalizeObsidianMathDelimiters(text: string): string {
  const withBlockMath = text.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, expression: string) => {
    const normalizedExpression = expression.trim();
    return normalizedExpression.length > 0 ? `$$\n${normalizedExpression}\n$$` : "$$\n$$";
  });

  return withBlockMath.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_match, expression: string) => {
    const normalizedExpression = expression.trim();
    return normalizedExpression.length > 0 ? `$${normalizedExpression}$` : "$$";
  });
}

export function buildDefaultUserAgent(pluginVersion: string): string {
  return `${DEFAULT_FIREFOX_USER_AGENT} chats2md/${pluginVersion}`;
}

export function parseSessionJson(raw: string, pluginVersion = "0.1.0"): ChatGptRequestConfig {
  let payload: SessionPayload;

  try {
    payload = JSON.parse(raw) as SessionPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
    throw new Error(`Invalid session JSON: ${message}`);
  }

  const headers = parseCustomHeaders(payload.headers);
  const accessToken = readString(payload.accessToken);
  const accountId = readString(payload.account?.id);
  const userId = readString(payload.user?.id);
  const userEmail = readString(payload.user?.email);
  const cookie = readString(payload.cookie, readString(payload.headers?.Cookie ?? payload.headers?.cookie));

  if (!accessToken) {
    throw new Error("Missing accessToken in session JSON.");
  }

  if (!accountId) {
    throw new Error("Missing account.id in session JSON.");
  }

  return {
    accessToken,
    accountId,
    userId,
    userEmail,
    cookie,
    headers,
    userAgent: buildDefaultUserAgent(pluginVersion),
    expiresAt: readString(payload.expires),
  };
}
