import { requestUrl } from "obsidian";
import {
  extractConversationListPageInfo,
  getNextConversationListOffset,
  normalizeConversationTimestamp,
  shouldFetchNextConversationListPage
} from "./conversation-utils";

import type {
  ChatGptRequestConfig,
  ConversationDetail,
  ConversationFileReference,
  ConversationFileReferenceKind,
  ConversationMessage,
  ConversationSummary
} from "./types";

const BASE_URL = "https://chatgpt.com";
const DEFAULT_LIST_PAGE_LIMIT = 28;
const MAX_LIST_PAGE_LIMIT = 100;
const MAX_LIST_PAGE_REQUESTS = 100;
const MAX_RATE_LIMIT_RETRIES = 6;
const MIN_RATE_LIMIT_BACKOFF_MS = 60000;
const MAX_RATE_LIMIT_BACKOFF_MS = 600000;
const DEFAULT_FIREFOX_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0";
const RESERVED_HEADER_NAMES = new Set([
  "accept",
  "authorization",
  "chatgpt-account-id",
  "cookie",
  "user-agent"
]);

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

interface FileDownloadInfo {
  downloadUrl: string;
  fileName: string;
}

export interface DownloadedFileContent {
  data: ArrayBuffer;
  contentType: string | null;
}

interface MappingExtractionResult {
  messages: ConversationMessage[];
  fileReferences: ConversationFileReference[];
}

export interface ConversationDetailFetchResult {
  detail: ConversationDetail;
  rawPayload: unknown;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function toRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
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

function parseCustomHeaders(value: unknown): Record<string, string> {
  const record = toRecord(value);

  if (!record) {
    return {};
  }

  const headers: Record<string, string> = {};

  for (const [key, headerValue] of Object.entries(record)) {
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

function stripCitationMarkers(text: string): string {
  return text.replace(/\u3010[^\u3011]*\u3011/g, "");
}

export function normalizeObsidianMathDelimiters(text: string): string {
  const withBlockMath = text.replace(/\\\[\s*([\s\S]*?)\s*\\\]/g, (_match, expression: string) => {
    const normalizedExpression = expression.trim();
    return normalizedExpression.length > 0
      ? `$$\n${normalizedExpression}\n$$`
      : "$$\n$$";
  });

  return withBlockMath.replace(/\\\(\s*([\s\S]*?)\s*\\\)/g, (_match, expression: string) => {
    const normalizedExpression = expression.trim();
    return normalizedExpression.length > 0
      ? `$${normalizedExpression}$`
      : "$$";
  });
}

function normalizeMessageText(text: string): string {
  return normalizeObsidianMathDelimiters(stripCitationMarkers(text));
}

export function buildDefaultUserAgent(pluginVersion: string): string {
  return `${DEFAULT_FIREFOX_USER_AGENT} chats2md/${pluginVersion}`;
}

interface ConversationListPageInfo {
  limit: number;
  offset: number;
  total: number | null;
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
  const total = Number.isFinite(parsed?.total) && (parsed.total ?? -1) >= 0
    ? Math.trunc(parsed.total ?? 0)
    : null;

  return {
    limit,
    offset,
    total
  };
}

function buildListUrl(limit: number, offset = 0): string {
  const params = new URLSearchParams({
    offset: String(Math.max(0, Math.trunc(offset))),
    limit: String(clampPageLimit(limit)),
    order: "updated",
    is_archived: "false",
    is_starred: "false"
  });

  return `${BASE_URL}/backend-api/conversations?${params.toString()}`;
}

function buildDetailUrl(conversationId: string): string {
  return `${BASE_URL}/backend-api/conversation/${conversationId}`;
}

function buildFileDownloadUrl(fileId: string): string {
  return `${BASE_URL}/backend-api/files/download/${encodeURIComponent(fileId)}`;
}

function buildHeaders(
  config: ChatGptRequestConfig,
  extraHeaders: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    ...config.headers,
    ...extraHeaders,
    Accept: "application/json",
    Authorization: `Bearer ${config.accessToken}`,
    "User-Agent": config.userAgent
  };

  if (config.accountId) {
    headers["ChatGPT-Account-ID"] = config.accountId;
  }

  if (config.cookie) {
    headers.Cookie = config.cookie;
  }

  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readHeader(headers: unknown, targetName: string): string | null {
  const headerRecord = toRecord(headers);

  if (!headerRecord) {
    return null;
  }

  for (const [name, value] of Object.entries(headerRecord)) {
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

  const baseDelay = Math.min(MAX_RATE_LIMIT_BACKOFF_MS, MIN_RATE_LIMIT_BACKOFF_MS * (2 ** attempt));
  const jitter = Math.round(baseDelay * 0.2 * Math.random());
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, baseDelay + jitter);
}

async function requestJson(
  url: string,
  config: ChatGptRequestConfig,
  extraHeaders: Record<string, string>
): Promise<unknown> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await requestUrl({
      url,
      method: "GET",
      headers: buildHeaders(config, extraHeaders)
    });

    if (response.status < 400) {
      return response.json;
    }

    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterMs = parseRetryAfterMs(readHeader(response.headers, "retry-after"));
      const backoffMs = computeRateLimitDelayMs(attempt, retryAfterMs);
      await sleep(backoffMs);
      continue;
    }

    const bodyText = typeof response.text === "string" && response.text.trim().length > 0
      ? response.text
      : JSON.stringify(response.json);

    throw new Error(`ChatGPT request failed with HTTP ${response.status}: ${bodyText}`);
  }

  throw new Error("ChatGPT request failed after exhausting rate-limit retries.");
}

async function requestArrayBuffer(
  url: string,
  config: ChatGptRequestConfig,
  extraHeaders: Record<string, string>
): Promise<DownloadedFileContent> {
  const response = await requestUrl({
    url,
    method: "GET",
    headers: buildHeaders(config, extraHeaders)
  });

  if (response.status >= 400) {
    const bodyText = typeof response.text === "string" && response.text.trim().length > 0
      ? response.text
      : JSON.stringify(response.json);
    throw new Error(`ChatGPT binary request failed with HTTP ${response.status}: ${bodyText}`);
  }

  return {
    data: response.arrayBuffer,
    contentType: readHeader(response.headers, "content-type")
  };
}

function normalizeSummary(item: UnknownRecord): ConversationSummary {
  const id = readString(item.id);

  if (!id) {
    throw new Error("A conversation item is missing its id.");
  }

  const title = readString(item.title, "Untitled Conversation");
  const createdAt = normalizeConversationTimestamp(item.create_time);
  const updatedAt = normalizeConversationTimestamp(
    item.update_time ?? item.updated_time,
    createdAt
  );

  return {
    id,
    title,
    createdAt,
    updatedAt,
    url: `${BASE_URL}/c/${id}`
  };
}

function wrapHtmlTagsInBackticks(text: string): string {
  return text.replace(/<[^>]+>/g, (match) => `\`${match}\``);
}

function blockquoteMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function collectTextFragments(value: unknown, fragments: string[], seen: WeakSet<object>): void {
  if (typeof value === "string") {
    const cleaned = normalizeMessageText(value);
    if (cleaned.trim().length > 0) {
      fragments.push(cleaned);
    }

    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTextFragments(item, fragments, seen);
    }

    return;
  }

  const record = toRecord(value);

  if (!record) {
    return;
  }

  if (seen.has(record)) {
    return;
  }

  seen.add(record);

  if (Array.isArray(record.parts)) {
    collectTextFragments(record.parts, fragments, seen);
  }

  if (typeof record.text === "string") {
    collectTextFragments(record.text, fragments, seen);
  }

  if (typeof record.result === "string") {
    collectTextFragments(record.result, fragments, seen);
  }

  if (typeof record.content === "string" || Array.isArray(record.content)) {
    collectTextFragments(record.content, fragments, seen);
  } else {
    collectTextFragments(record.content, fragments, seen);
  }
}

function extractMessageContent(message: UnknownRecord): string {
  const content = message.content;
  const fragments: string[] = [];
  collectTextFragments(content, fragments, new WeakSet<object>());
  return fragments.join("\n\n").trim();
}

function buildFilePlaceholder(kind: ConversationFileReferenceKind, fileId: string): string {
  return `[[chats2md:${kind}:${fileId}]]`;
}

function parseAssetPointer(value: unknown): string | null {
  const pointer = readString(value);

  if (!pointer) {
    return null;
  }

  const match = pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
  return match?.[1] ?? null;
}

function defaultLogicalNameForKind(kind: ConversationFileReferenceKind): string {
  switch (kind) {
    case "image":
      return "image.png";
    case "citation":
      return "citation";
    case "attachment":
    default:
      return "attachment";
  }
}

function registerFileReference(
  refs: Map<string, ConversationFileReference>,
  kind: ConversationFileReferenceKind,
  fileId: string,
  logicalName: string
): ConversationFileReference {
  const key = `${kind}:${fileId}`;
  const existing = refs.get(key);

  if (existing) {
    return existing;
  }

  const normalizedName = logicalName.trim().length > 0 ? logicalName.trim() : defaultLogicalNameForKind(kind);
  const reference: ConversationFileReference = {
    fileId,
    kind,
    logicalName: normalizedName,
    placeholder: buildFilePlaceholder(kind, fileId)
  };
  refs.set(key, reference);
  return reference;
}

function extractMetadataPlaceholders(
  message: UnknownRecord,
  refs: Map<string, ConversationFileReference>
): string[] {
  const metadata = toRecord(message.metadata);
  const placeholders: string[] = [];
  const seen = new Set<string>();

  const attachments = Array.isArray(metadata?.attachments) ? metadata.attachments : [];
  for (const attachment of attachments) {
    const record = toRecord(attachment);
    const fileId = readString(record?.id);
    if (!fileId) {
      continue;
    }

    const reference = registerFileReference(refs, "attachment", fileId, readString(record?.name, "attachment"));
    if (seen.has(reference.placeholder)) {
      continue;
    }
    seen.add(reference.placeholder);
    placeholders.push(`Attachment: ${reference.placeholder}`);
  }

  const citations = Array.isArray(metadata?.citations) ? metadata.citations : [];
  for (const citation of citations) {
    const record = toRecord(citation);
    const citationMetadata = toRecord(record?.metadata);
    const fileId = readString(citationMetadata?.file_id, readString(record?.file_id));
    if (!fileId) {
      continue;
    }

    const logicalName = readString(citationMetadata?.title, readString(record?.title, "citation"));
    const reference = registerFileReference(refs, "citation", fileId, logicalName);
    if (seen.has(reference.placeholder)) {
      continue;
    }
    seen.add(reference.placeholder);
    placeholders.push(`Citation: ${reference.placeholder}`);
  }

  return placeholders;
}

function renderMultimodalPart(part: unknown, refs: Map<string, ConversationFileReference>): string {
  if (typeof part === "string") {
    return normalizeMessageText(part);
  }

  const record = toRecord(part);

  if (!record) {
    return "";
  }

  if (readString(record.content_type) === "image_asset_pointer") {
    const fileId = parseAssetPointer(record.asset_pointer);
    const metadata = toRecord(record.metadata);
    const dalle = toRecord(metadata?.dalle);
    const prompt = readString(dalle?.prompt);
    if (fileId) {
      const logicalName = prompt ? "dalle_image.png" : "image.png";
      return registerFileReference(refs, "image", fileId, logicalName).placeholder;
    }

    const width = readString(record.width, "?");
    const height = readString(record.height, "?");
    return `Image (${width}x${height})${prompt ? `: ${prompt}` : ""}`;
  }

  return normalizeMessageText(readString(record.text, readString(record.content_type, "")));
}

function renderThoughts(content: UnknownRecord): string {
  const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];

  return thoughts
    .map((thought) => {
      const record = toRecord(thought);

      if (!record) {
        return "";
      }

      const summary = readString(record.summary, "Thought");
      const body = normalizeMessageText(readString(record.content));

      if (!body) {
        return "";
      }

      return `##### ${summary}\n\n${body}`;
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function renderMessageBody(
  message: UnknownRecord,
  refs: Map<string, ConversationFileReference>
): string {
  const content = toRecord(message.content);

  if (!content) {
    return "";
  }

  const contentType = readString(content.content_type);

  switch (contentType) {
    case "text":
      return normalizeMessageText(wrapHtmlTagsInBackticks(
        Array.isArray(content.parts) ? content.parts.filter((part): part is string => typeof part === "string").join("\n") : ""
      ));
    case "code":
      return `\`\`\`${readString(content.language).replace("unknown", "")}\n${readString(content.text)}\n\`\`\``;
    case "execution_output":
      return `\`\`\`\n${readString(content.text)}\n\`\`\``;
    case "multimodal_text":
      return (Array.isArray(content.parts) ? content.parts : [])
        .map((part) => renderMultimodalPart(part, refs))
        .filter((part) => part.length > 0)
        .join("\n\n");
    case "tether_browsing_display": {
      const summary = readString(content.summary);
      const result = readString(content.result);
      return `\`\`\`\n${summary ? `${summary}\n` : ""}${result}\n\`\`\``;
    }
    case "tether_quote":
      return normalizeMessageText(blockquoteMarkdown(
        `${readString(content.title)} (${readString(content.url)})\n\n${readString(content.text)}`
      ));
    case "system_error":
      return [readString(content.name), readString(content.text)].filter((part) => part.length > 0).join("\n\n");
    case "user_editable_context":
      return "";
    case "thoughts":
      return renderThoughts(content);
    case "reasoning_recap":
      return normalizeMessageText(blockquoteMarkdown(readString(content.content)));
    case "sonic_webpage":
      return normalizeMessageText(`\`\`\`\n${readString(content.title)} (${readString(content.url)})\n\n${readString(content.text)}\n\`\`\``);
    default:
      return extractMessageContent(message);
  }
}

function renderMessageMarkdown(
  message: UnknownRecord,
  nodeId: string,
  refs: Map<string, ConversationFileReference>
): string {
  const author = toRecord(message.author);
  const role = readString(author?.role, readString(author?.name, "message")).toLowerCase();
  let body = renderMessageBody(message, refs);
  const metadataPlaceholders = extractMetadataPlaceholders(message, refs);

  if (metadataPlaceholders.length > 0) {
    body = [body, ...metadataPlaceholders].filter((part) => part.trim().length > 0).join("\n\n");
  }

  if (!body.trim()) {
    return "";
  }

  if (role === "user") {
    body = blockquoteMarkdown(body);
  } else if (role === "tool" && !body.startsWith("```") && !body.endsWith("```")) {
    body = blockquoteMarkdown(body);
  }

  const authorName = readString(author?.name);
  const heading = `## ${role}${authorName ? ` (${authorName})` : ""}`;

  return [heading, "", body.trimEnd()].join("\n");
}

function extractMessagesFromMapping(payload: UnknownRecord): MappingExtractionResult {
  const mapping = toRecord(payload.mapping);
  const currentNodeId = readString(payload.current_node);

  if (!mapping || !currentNodeId) {
    throw new Error("Conversation payload is missing mapping/current_node.");
  }

  const path: string[] = [];
  const seenNodeIds = new Set<string>();
  let cursor = currentNodeId;

  while (cursor.length > 0 && !seenNodeIds.has(cursor)) {
    const node = toRecord(mapping[cursor]);

    if (!node) {
      break;
    }

    path.push(cursor);
    seenNodeIds.add(cursor);
    cursor = readString(node.parent);
  }

  path.reverse();

  const messages: ConversationMessage[] = [];
  const fileReferences = new Map<string, ConversationFileReference>();

  for (const nodeId of path) {
    const node = toRecord(mapping[nodeId]);
    const message = toRecord(node?.message);

    if (!message) {
      continue;
    }

    const author = toRecord(message.author);
    const role = readString(author?.role, readString(author?.name, "message")).toLowerCase();
    const markdown = renderMessageMarkdown(message, nodeId, fileReferences);

    if (!markdown) {
      continue;
    }

    messages.push({
      id: readString(message.id, nodeId),
      role,
      markdown
    });
  }

  return {
    messages,
    fileReferences: Array.from(fileReferences.values())
  };
}

function normalizeConversationDetail(
  payload: unknown,
  conversationId: string,
  fallback?: Pick<ConversationSummary, "title" | "createdAt" | "updatedAt">
): ConversationDetail {
  const record = toRecord(payload);

  if (!record) {
    throw new Error("Conversation detail response is not a JSON object.");
  }

  const title = readString(record.title, fallback?.title ?? "Untitled Conversation");
  const createdAt = normalizeConversationTimestamp(record.create_time, fallback?.createdAt ?? "");
  const updatedAt = normalizeConversationTimestamp(
    record.update_time ?? record.updated_time,
    fallback?.updatedAt ?? createdAt
  );

  const mappingData = extractMessagesFromMapping(record);

  return {
    id: readString(record.conversation_id ?? record.id, conversationId),
    title,
    createdAt,
    updatedAt,
    url: `${BASE_URL}/c/${conversationId}`,
    messages: mappingData.messages,
    fileReferences: mappingData.fileReferences
  };
}

export function parseConversationDetailPayload(
  payload: unknown,
  conversationId: string,
  fallback?: Pick<ConversationSummary, "title" | "createdAt" | "updatedAt">
): ConversationDetail {
  return normalizeConversationDetail(payload, conversationId, fallback);
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
    expiresAt: readString(payload.expires)
  };
}

export async function fetchConversationSummaries(
  config: ChatGptRequestConfig
): Promise<ConversationSummary[]> {
  const listPageLimit = 99;
  const summaries: ConversationSummary[] = [];
  const seenConversationIds = new Set<string>();
  let offset = 0;
  let expectedTotal: number | null = null;
  let stableIntervals = 0;

  for (let page = 0; page < MAX_LIST_PAGE_REQUESTS; page += 1) {
    const payload = await requestJson(buildListUrl(listPageLimit, offset), config, {
      "X-OpenAI-Target-Path": "/backend-api/conversations",
      "X-OpenAI-Target-Route": "/backend-api/conversations"
    });
    const pageInfo = readPageInfo(payload, listPageLimit);
    const pageSummaries = extractConversationItems(payload).map(normalizeSummary);
    const previousTotal = summaries.length;

    for (const summary of pageSummaries) {
      if (seenConversationIds.has(summary.id)) {
        continue;
      }

      seenConversationIds.add(summary.id);
      summaries.push(summary);
    }

    if (pageInfo.total !== null) {
      expectedTotal = expectedTotal === null
        ? pageInfo.total
        : Math.max(expectedTotal, pageInfo.total);
    }

    if (pageSummaries.length === 0) {
      break;
    }

    if (!shouldFetchNextConversationListPage(pageSummaries.length, pageInfo, listPageLimit)) {
      break;
    }

    if (expectedTotal !== null && summaries.length >= expectedTotal) {
      break;
    }

    if (summaries.length === previousTotal) {
      stableIntervals += 1;
    } else {
      stableIntervals = 0;
    }

    if (stableIntervals >= 1) {
      break;
    }

    offset = getNextConversationListOffset(offset, pageInfo, listPageLimit);
  }

  return summaries;
}

export async function validateConversationListAccess(config: ChatGptRequestConfig): Promise<void> {
  const payload = await requestJson(buildListUrl(1, 0), config, {
    "X-OpenAI-Target-Path": "/backend-api/conversations",
    "X-OpenAI-Target-Route": "/backend-api/conversations"
  });
  extractConversationItems(payload);
}

export async function fetchConversationDetail(
  config: ChatGptRequestConfig,
  conversationId: string,
  fallback?: Pick<ConversationSummary, "title" | "createdAt" | "updatedAt">
): Promise<ConversationDetail> {
  const result = await fetchConversationDetailWithPayload(config, conversationId, fallback);
  return result.detail;
}

export async function fetchConversationDetailWithPayload(
  config: ChatGptRequestConfig,
  conversationId: string,
  fallback?: Pick<ConversationSummary, "title" | "createdAt" | "updatedAt">
): Promise<ConversationDetailFetchResult> {
  const targetPath = `/backend-api/conversation/${conversationId}`;
  const payload = await requestJson(buildDetailUrl(conversationId), config, {
    Referer: `${BASE_URL}/c/${conversationId}`,
    "X-OpenAI-Target-Path": targetPath,
    "X-OpenAI-Target-Route": "/backend-api/conversation/{conversation_id}"
  });

  return {
    detail: normalizeConversationDetail(payload, conversationId, fallback),
    rawPayload: payload
  };
}

function normalizeFileDownloadInfo(payload: unknown, fileId: string): FileDownloadInfo {
  const record = toRecord(payload);

  if (!record) {
    throw new Error(`File download metadata for ${fileId} is not a JSON object.`);
  }

  const downloadUrl = readString(record.download_url);
  if (!downloadUrl) {
    throw new Error(`File download metadata for ${fileId} is missing download_url.`);
  }

  const fileName = readString(record.file_name);
  return {
    downloadUrl,
    fileName: fileName || fileId
  };
}

export async function fetchConversationFileDownloadInfo(
  config: ChatGptRequestConfig,
  fileId: string
): Promise<FileDownloadInfo> {
  const targetPath = `/backend-api/files/download/${fileId}`;
  const payload = await requestJson(buildFileDownloadUrl(fileId), config, {
    "X-OpenAI-Target-Path": targetPath,
    "X-OpenAI-Target-Route": "/backend-api/files/download/{file_id}"
  });

  return normalizeFileDownloadInfo(payload, fileId);
}

export async function fetchSignedFileContent(
  config: ChatGptRequestConfig,
  url: string
): Promise<DownloadedFileContent> {
  return requestArrayBuffer(url, config, {
    Accept: "*/*"
  });
}
