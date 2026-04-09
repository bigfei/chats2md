import { extractConversationListPageInfo, normalizeConversationTimestamp } from "./conversation-utils";
import { parseConversationDetailPayload as parseConversationDetailPayloadImpl } from "./conversation-detail-parser";
import {
  fetchConversationSummariesWithPageFetcher,
  type ConversationListPageInfo,
  type FetchConversationSummariesPageProgress,
  type FetchConversationSummariesPageRetryProgress,
  type FetchConversationSummariesResult,
} from "./conversation-list-fetch";
import { normalizeFileDownloadInfo, type FileDownloadInfo } from "./file-download-info";
import { requestBinary, requestJsonWithRetries, type RequestLikeFn } from "./request-core";

import type { ChatGptRequestConfig, ConversationDetail, ConversationSummary } from "../shared/types";

export { parseConversationDetailPayload } from "./conversation-detail-parser";
export { buildDefaultUserAgent, normalizeObsidianMathDelimiters, parseSessionJson } from "./session-config";

const BASE_URL = "https://chatgpt.com";
const DEFAULT_LIST_PAGE_LIMIT = 28;
const MAX_LIST_PAGE_LIMIT = 100;
const CONVERSATION_LIST_FETCH_PARALLELISM = 1;
const CONVERSATION_LIST_PAGE_LIMIT = 100;

let requestUrlLoader: Promise<RequestLikeFn> | null = null;

async function loadRequestUrl(): Promise<RequestLikeFn> {
  if (!requestUrlLoader) {
    requestUrlLoader = Promise.resolve().then(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const module = require("obsidian") as { requestUrl?: unknown };
        if (typeof module.requestUrl !== "function") {
          throw new Error("obsidian.requestUrl is unavailable.");
        }

        return module.requestUrl as RequestLikeFn;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load Obsidian requestUrl: ${message}`);
      }
    });
  }

  return requestUrlLoader;
}

type UnknownRecord = Record<string, unknown>;

export interface DownloadedFileContent {
  data: ArrayBuffer;
  contentType: string | null;
}

export interface ConversationDetailFetchResult {
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

function clampPageLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DEFAULT_LIST_PAGE_LIMIT;
  }

  return Math.min(MAX_LIST_PAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}

function readPageInfo(payload: unknown, fallbackLimit = DEFAULT_LIST_PAGE_LIMIT): ConversationListPageInfo {
  const parsed = extractConversationListPageInfo(payload, fallbackLimit) as {
    limit?: number;
    offset?: number;
    total?: number | null;
  };

  const limit = clampPageLimit(parsed?.limit ?? fallbackLimit);
  const offset = Number.isFinite(parsed?.offset) ? Math.max(0, Math.trunc(parsed.offset ?? 0)) : 0;
  const total = Number.isFinite(parsed?.total) && (parsed.total ?? -1) >= 0 ? Math.trunc(parsed.total ?? 0) : null;

  return {
    limit,
    offset,
    total,
  };
}

function buildListUrl(limit: number, offset = 0): string {
  const params = new URLSearchParams({
    offset: String(Math.max(0, Math.trunc(offset))),
    limit: String(clampPageLimit(limit)),
    is_archived: "false",
    is_starred: "false",
  });

  return `${BASE_URL}/backend-api/conversations?${params.toString()}`;
}

function buildDetailUrl(conversationId: string): string {
  return `${BASE_URL}/backend-api/conversation/${conversationId}`;
}

function buildFileDownloadUrl(fileId: string): string {
  return `${BASE_URL}/backend-api/files/download/${encodeURIComponent(fileId)}`;
}

function shouldIncludeSessionHeadersForBinaryDownload(url: string): boolean {
  try {
    const parsed = new URL(url, BASE_URL);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

function buildHeaders(config: ChatGptRequestConfig, extraHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    ...config.headers,
    ...extraHeaders,
    Accept: "application/json",
    Authorization: `Bearer ${config.accessToken}`,
    "User-Agent": config.userAgent,
  };

  if (config.accountId) {
    headers["ChatGPT-Account-ID"] = config.accountId;
  }

  if (config.cookie) {
    headers.Cookie = config.cookie;
  }

  return headers;
}

async function requestJson(
  url: string,
  config: ChatGptRequestConfig,
  extraHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const requestUrl = await loadRequestUrl();

  return requestJsonWithRetries(
    requestUrl,
    {
      url,
      method: "GET",
      headers: buildHeaders(config, extraHeaders),
      throw: false,
    },
    undefined,
    signal,
    config.rateLimitMonitor,
  );
}

async function requestArrayBuffer(
  url: string,
  config: ChatGptRequestConfig,
  extraHeaders: Record<string, string>,
  options: { includeSessionHeaders?: boolean } = {},
  signal?: AbortSignal,
): Promise<DownloadedFileContent> {
  const requestUrl = await loadRequestUrl();

  const headers =
    options.includeSessionHeaders === false
      ? {
          ...extraHeaders,
          "User-Agent": config.userAgent,
        }
      : buildHeaders(config, extraHeaders);

  return requestBinary(
    requestUrl,
    {
      url,
      method: "GET",
      headers,
      throw: false,
    },
    signal,
    config.rateLimitMonitor,
  );
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

export interface FetchConversationSummariesOptions {
  pageLimit?: number;
  parallelism?: number;
  retryAttempts?: number;
  onPageFetched?: (progress: FetchConversationSummariesPageProgress) => void;
  onPageRetry?: (progress: FetchConversationSummariesPageRetryProgress) => void;
  signal?: AbortSignal;
}

export async function fetchConversationSummaries(
  config: ChatGptRequestConfig,
  options: FetchConversationSummariesOptions = {},
): Promise<FetchConversationSummariesResult> {
  const pageLimit = clampPageLimit(options.pageLimit ?? CONVERSATION_LIST_PAGE_LIMIT);
  const parallelism = Math.max(1, Math.trunc(options.parallelism ?? CONVERSATION_LIST_FETCH_PARALLELISM));

  return fetchConversationSummariesWithPageFetcher(
    async (offset) => {
      const payload = await requestJson(
        buildListUrl(pageLimit, offset),
        config,
        {
          "X-OpenAI-Target-Path": "/backend-api/conversations",
          "X-OpenAI-Target-Route": "/backend-api/conversations",
        },
        options.signal,
      );

      return {
        pageInfo: readPageInfo(payload, pageLimit),
        pageSummaries: extractConversationItems(payload).map(normalizeSummary),
      };
    },
    {
      pageLimit,
      parallelism,
      retryAttempts: options.retryAttempts,
      onPageFetched: options.onPageFetched,
      onPageRetry: options.onPageRetry,
      signal: options.signal,
    },
  );
}

export async function validateConversationListAccess(config: ChatGptRequestConfig): Promise<void> {
  const payload = await requestJson(buildListUrl(1, 0), config, {
    "X-OpenAI-Target-Path": "/backend-api/conversations",
    "X-OpenAI-Target-Route": "/backend-api/conversations",
  });
  extractConversationItems(payload);
}

export async function fetchConversationDetail(
  config: ChatGptRequestConfig,
  conversationId: string,
  fallback?: Pick<ConversationSummary, "title" | "createdAt" | "updatedAt">,
  signal?: AbortSignal,
): Promise<ConversationDetail> {
  const result = await fetchConversationDetailWithPayload(config, conversationId, fallback, signal);
  return result.detail;
}

export async function fetchConversationDetailWithPayload(
  config: ChatGptRequestConfig,
  conversationId: string,
  fallback?: Pick<ConversationSummary, "title" | "createdAt" | "updatedAt">,
  signal?: AbortSignal,
): Promise<ConversationDetailFetchResult> {
  const targetPath = `/backend-api/conversation/${conversationId}`;
  const payload = await requestJson(
    buildDetailUrl(conversationId),
    config,
    {
      Referer: `${BASE_URL}/c/${conversationId}`,
      "X-OpenAI-Target-Path": targetPath,
      "X-OpenAI-Target-Route": "/backend-api/conversation/{conversation_id}",
    },
    signal,
  );

  return {
    detail: parseConversationDetailPayloadImpl(payload, conversationId, fallback),
    rawPayload: payload,
  };
}

export async function fetchConversationFileDownloadInfo(
  config: ChatGptRequestConfig,
  fileId: string,
  signal?: AbortSignal,
): Promise<FileDownloadInfo> {
  const targetPath = `/backend-api/files/download/${fileId}`;
  const payload = await requestJson(
    buildFileDownloadUrl(fileId),
    config,
    {
      "X-OpenAI-Target-Path": targetPath,
      "X-OpenAI-Target-Route": "/backend-api/files/download/{file_id}",
    },
    signal,
  );

  return normalizeFileDownloadInfo(payload, fileId);
}

export async function fetchSignedFileContent(
  config: ChatGptRequestConfig,
  url: string,
  signal?: AbortSignal,
): Promise<DownloadedFileContent> {
  const includeSessionHeaders = shouldIncludeSessionHeadersForBinaryDownload(url);
  return requestArrayBuffer(
    url,
    config,
    {
      Accept: "*/*",
    },
    {
      includeSessionHeaders,
    },
    signal,
  );
}
