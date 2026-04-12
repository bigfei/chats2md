import {
  createStaticAuthProvider,
  type AuthProvider,
  type SyncSourceAdapter,
  type Transport,
} from "@chats2md/sync-core";

import {
  extractConversationListPageInfo,
  getNextConversationListOffset,
  normalizeConversationTimestamp,
} from "./conversation-utils";
import { parseConversationDetailPayload } from "./conversation-detail-parser";
import { requestJsonWithRetries, type RequestLikeFn } from "./request-core";
import { sortConversationSummariesByCreatedAtDesc } from "./conversation-list-fetch";

import type { ChatGptRequestConfig, ConversationDetail, ConversationSummary } from "../shared/types";

const BASE_URL = "https://chatgpt.com";
const DEFAULT_LIST_PAGE_LIMIT = 100;

type UnknownRecord = Record<string, unknown>;

interface ConversationDetailFetchResult {
  detail: ConversationDetail;
  rawPayload: unknown;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function toRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function extractConversationItems(payload: unknown): UnknownRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is UnknownRecord => toRecord(item) !== null);
  }

  const record = toRecord(payload);

  if (record) {
    for (const key of ["items", "conversations"]) {
      const value = record[key];

      if (Array.isArray(value)) {
        return value.filter((item): item is UnknownRecord => toRecord(item) !== null);
      }
    }
  }

  throw new Error("Could not find a conversation list in the API response.");
}

function normalizeSummary(item: UnknownRecord): ConversationSummary {
  const id = readString(item.id);

  if (!id) {
    throw new Error("A conversation item is missing its id.");
  }

  const title = readString(item.title, "Untitled Conversation");
  const createdAt = normalizeConversationTimestamp(item.create_time);
  const updatedAt = normalizeConversationTimestamp(item.update_time ?? item.updated_time, createdAt);

  return {
    id,
    title,
    createdAt,
    updatedAt,
    url: `${BASE_URL}/c/${id}`,
  };
}

function buildListUrl(limit: number, offset = 0): string {
  const params = new URLSearchParams({
    offset: String(Math.max(0, Math.trunc(offset))),
    limit: String(Math.max(1, Math.trunc(limit))),
    is_archived: "false",
    is_starred: "false",
  });

  return `${BASE_URL}/backend-api/conversations?${params.toString()}`;
}

function buildDetailUrl(conversationId: string): string {
  return `${BASE_URL}/backend-api/conversation/${conversationId}`;
}

function readPageInfo(
  payload: unknown,
  fallbackLimit = DEFAULT_LIST_PAGE_LIMIT,
): {
  limit: number;
  offset: number;
  total: number | null;
} {
  const parsed = extractConversationListPageInfo(payload, fallbackLimit) as {
    limit?: number;
    offset?: number;
    total?: number | null;
  };

  const limit = Number.isFinite(parsed?.limit) ? Math.max(1, Math.trunc(parsed.limit ?? fallbackLimit)) : fallbackLimit;
  const offset = Number.isFinite(parsed?.offset) ? Math.max(0, Math.trunc(parsed.offset ?? 0)) : 0;
  const total = Number.isFinite(parsed?.total) && (parsed.total ?? -1) >= 0 ? Math.trunc(parsed.total ?? 0) : null;

  return {
    limit,
    offset,
    total,
  };
}

function createTransportRequestFn(
  transport: Transport,
  authProvider: AuthProvider | undefined,
  signal?: AbortSignal,
): RequestLikeFn {
  return async (params) =>
    transport({
      url: params.url,
      method: params.method,
      headers: params.headers,
      signal,
      auth: authProvider,
      metadata: {
        source: "chatgpt",
      },
    });
}

function parseSummaryTimestamp(value: string): number | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickPreferredSummary(existing: ConversationSummary, candidate: ConversationSummary): ConversationSummary {
  const existingUpdatedAt = parseSummaryTimestamp(existing.updatedAt) ?? Number.NEGATIVE_INFINITY;
  const candidateUpdatedAt = parseSummaryTimestamp(candidate.updatedAt) ?? Number.NEGATIVE_INFINITY;

  if (candidateUpdatedAt > existingUpdatedAt) {
    return candidate;
  }

  return existing;
}

async function fetchConversationDetailWithPayload(
  config: ChatGptRequestConfig,
  transport: Transport,
  authProvider: AuthProvider | undefined,
  conversationId: string,
  fallback?: Pick<ConversationSummary, "title" | "createdAt" | "updatedAt">,
  signal?: AbortSignal,
): Promise<ConversationDetailFetchResult> {
  const targetPath = `/backend-api/conversation/${conversationId}`;
  const payload = await requestJsonWithRetries(
    createTransportRequestFn(transport, authProvider, signal),
    {
      url: buildDetailUrl(conversationId),
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": config.userAgent,
        Referer: `${BASE_URL}/c/${conversationId}`,
        "X-OpenAI-Target-Path": targetPath,
        "X-OpenAI-Target-Route": "/backend-api/conversation/{conversation_id}",
        ...(config.accountId ? { "ChatGPT-Account-ID": config.accountId } : {}),
      },
      throw: false,
    },
    undefined,
    signal,
    config.rateLimitMonitor,
  );

  return {
    detail: parseConversationDetailPayload(payload, conversationId, fallback),
    rawPayload: payload,
  };
}

export function createChatGptAuthProvider(config: ChatGptRequestConfig): AuthProvider {
  return createStaticAuthProvider({
    bearerToken: config.accessToken,
    headers: config.headers,
    cookie: config.cookie,
  });
}

export function createChatGptSyncSource(
  config: ChatGptRequestConfig,
): SyncSourceAdapter<number, ConversationSummary, ConversationDetail, null> {
  return {
    sourceId: "chatgpt",
    capabilities: {
      full: true,
      dateRange: true,
    },
    getSummaryId: (summary) => summary.id,
    getSummaryCreatedAt: (summary) => summary.createdAt,
    mergeSummary: pickPreferredSummary,
    sortSummaries: sortConversationSummariesByCreatedAtDesc,
    async listPage(request) {
      const pageLimit = Math.max(1, Math.trunc(request.query.list?.pageLimit ?? DEFAULT_LIST_PAGE_LIMIT));
      const offset = Math.max(0, Math.trunc(request.cursor ?? 0));
      const payload = await requestJsonWithRetries(
        createTransportRequestFn(request.transport, request.authProvider, request.signal),
        {
          url: buildListUrl(pageLimit, offset),
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": config.userAgent,
            "X-OpenAI-Target-Path": "/backend-api/conversations",
            "X-OpenAI-Target-Route": "/backend-api/conversations",
            ...(config.accountId ? { "ChatGPT-Account-ID": config.accountId } : {}),
          },
          throw: false,
        },
        undefined,
        request.signal,
        config.rateLimitMonitor,
      );
      const pageInfo = readPageInfo(payload, pageLimit);
      const items = extractConversationItems(payload).map(normalizeSummary);
      const nextCursor =
        items.length > 0 && items.length >= pageInfo.limit
          ? getNextConversationListOffset(offset, pageInfo, pageLimit)
          : null;

      return {
        items,
        nextCursor,
        expectedTotal: pageInfo.total,
        checkpoint: null,
      };
    },
    async fetchRecord(request) {
      const result = await fetchConversationDetailWithPayload(
        config,
        request.transport,
        request.authProvider,
        request.summary.id,
        request.summary,
        request.signal,
      );

      return {
        record: result.detail,
        raw: result.rawPayload,
        checkpoint: null,
      };
    },
  };
}
