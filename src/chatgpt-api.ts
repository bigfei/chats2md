import { requestUrl } from "obsidian";

import type {
  ChatGptRequestConfig,
  ConversationDetail,
  ConversationMessage,
  ConversationSummary
} from "./types";

const BASE_URL = "https://chatgpt.com";
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
  account?: {
    id?: string;
  };
}

type UnknownRecord = Record<string, unknown>;

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

export function buildDefaultUserAgent(pluginVersion: string): string {
  return `${DEFAULT_FIREFOX_USER_AGENT} chats2md/${pluginVersion}`;
}

function buildListUrl(limit: number): string {
  const params = new URLSearchParams({
    offset: "0",
    limit: String(limit),
    order: "updated",
    is_archived: "false",
    is_starred: "false"
  });

  return `${BASE_URL}/backend-api/conversations?${params.toString()}`;
}

function buildDetailUrl(conversationId: string): string {
  return `${BASE_URL}/backend-api/conversation/${conversationId}`;
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

async function requestJson(
  url: string,
  config: ChatGptRequestConfig,
  extraHeaders: Record<string, string>
): Promise<unknown> {
  const response = await requestUrl({
    url,
    method: "GET",
    headers: buildHeaders(config, extraHeaders)
  });

  if (response.status >= 400) {
    const bodyText = typeof response.text === "string" && response.text.trim().length > 0
      ? response.text
      : JSON.stringify(response.json);

    throw new Error(`ChatGPT request failed with HTTP ${response.status}: ${bodyText}`);
  }

  return response.json;
}

function normalizeSummary(item: UnknownRecord): ConversationSummary {
  const id = readString(item.id);

  if (!id) {
    throw new Error("A conversation item is missing its id.");
  }

  const title = readString(item.title, "Untitled Conversation");
  const updatedAt = readString(item.update_time ?? item.updated_time);

  return {
    id,
    title,
    updatedAt,
    url: `${BASE_URL}/c/${id}`
  };
}

function wrapHtmlTagsInBackticks(text: string): string {
  return text.replace(/<[^>]+>/g, (match) => `\`${match}\``);
}

function indentMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `    ${line}` : ""))
    .join("\n")
    .trimEnd();
}

function blockquoteMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function collectTextFragments(value: unknown, fragments: string[], seen: WeakSet<object>): void {
  if (typeof value === "string") {
    if (value.trim().length > 0) {
      fragments.push(value);
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

function renderMultimodalPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }

  const record = toRecord(part);

  if (!record) {
    return "";
  }

  if (readString(record.content_type) === "image_asset_pointer") {
    const width = readString(record.width, "?");
    const height = readString(record.height, "?");
    const metadata = toRecord(record.metadata);
    const dalle = toRecord(metadata?.dalle);
    const prompt = readString(dalle?.prompt);
    return `Image (${width}x${height})${prompt ? `: ${prompt}` : ""}`;
  }

  return readString(record.text, readString(record.content_type, ""));
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
      const body = readString(record.content);

      if (!body) {
        return "";
      }

      return `##### ${summary}\n\n${body}`;
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function renderMessageBody(message: UnknownRecord): string {
  const content = toRecord(message.content);

  if (!content) {
    return "";
  }

  const contentType = readString(content.content_type);

  switch (contentType) {
    case "text":
      return wrapHtmlTagsInBackticks(
        Array.isArray(content.parts) ? content.parts.filter((part): part is string => typeof part === "string").join("\n") : ""
      );
    case "code":
      return `\`\`\`${readString(content.language).replace("unknown", "")}\n${readString(content.text)}\n\`\`\``;
    case "execution_output":
      return `\`\`\`\n${readString(content.text)}\n\`\`\``;
    case "multimodal_text":
      return (Array.isArray(content.parts) ? content.parts : [])
        .map(renderMultimodalPart)
        .filter((part) => part.length > 0)
        .join("\n\n");
    case "tether_browsing_display": {
      const summary = readString(content.summary);
      const result = readString(content.result);
      return `\`\`\`\n${summary ? `${summary}\n` : ""}${result}\n\`\`\``;
    }
    case "tether_quote":
      return blockquoteMarkdown(
        `${readString(content.title)} (${readString(content.url)})\n\n${readString(content.text)}`
      );
    case "system_error":
      return [readString(content.name), readString(content.text)].filter((part) => part.length > 0).join("\n\n");
    case "user_editable_context":
      return "";
    case "thoughts":
      return renderThoughts(content);
    case "reasoning_recap":
      return blockquoteMarkdown(readString(content.content));
    case "sonic_webpage":
      return `\`\`\`\n${readString(content.title)} (${readString(content.url)})\n\n${readString(content.text)}\n\`\`\``;
    default:
      return extractMessageContent(message);
  }
}

function renderMessageMarkdown(message: UnknownRecord, nodeId: string): string {
  const author = toRecord(message.author);
  const role = readString(author?.role, readString(author?.name, "message")).toLowerCase();
  let body = renderMessageBody(message);

  if (!body.trim()) {
    return "";
  }

  if (role === "user") {
    body = indentMarkdown(body);
  } else if (role === "tool" && !body.startsWith("```") && !body.endsWith("```")) {
    body = indentMarkdown(body);
  }

  const authorName = readString(author?.name);
  const heading = `## ${role}${authorName ? ` (${authorName})` : ""}`;

  return [heading, "", body.trimEnd()].join("\n");
}

function extractMessagesFromMapping(payload: UnknownRecord): ConversationMessage[] {
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

  for (const nodeId of path) {
    const node = toRecord(mapping[nodeId]);
    const message = toRecord(node?.message);

    if (!message) {
      continue;
    }

    const author = toRecord(message.author);
    const role = readString(author?.role, readString(author?.name, "message")).toLowerCase();
    const markdown = renderMessageMarkdown(message, nodeId);

    if (!markdown) {
      continue;
    }

    messages.push({
      id: readString(message.id, nodeId),
      role,
      markdown
    });
  }

  return messages;
}

function normalizeConversationDetail(
  payload: unknown,
  conversationId: string,
  fallback?: Pick<ConversationSummary, "title" | "updatedAt">
): ConversationDetail {
  const record = toRecord(payload);

  if (!record) {
    throw new Error("Conversation detail response is not a JSON object.");
  }

  const title = readString(record.title, fallback?.title ?? "Untitled Conversation");
  const updatedAt = readString(record.update_time ?? record.updated_time, fallback?.updatedAt ?? "");

  return {
    id: readString(record.conversation_id ?? record.id, conversationId),
    title,
    updatedAt,
    url: `${BASE_URL}/c/${conversationId}`,
    messages: extractMessagesFromMapping(record)
  };
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
    cookie,
    headers,
    userAgent: buildDefaultUserAgent(pluginVersion),
    expiresAt: readString(payload.expires)
  };
}

export async function fetchConversationSummaries(
  config: ChatGptRequestConfig,
  limit: number
): Promise<ConversationSummary[]> {
  const payload = await requestJson(buildListUrl(limit), config, {
    "X-OpenAI-Target-Path": "/backend-api/conversations",
    "X-OpenAI-Target-Route": "/backend-api/conversations"
  });

  return extractConversationItems(payload).map(normalizeSummary);
}

export async function fetchConversationDetail(
  config: ChatGptRequestConfig,
  conversationId: string,
  fallback?: Pick<ConversationSummary, "title" | "updatedAt">
): Promise<ConversationDetail> {
  const targetPath = `/backend-api/conversation/${conversationId}`;
  const payload = await requestJson(buildDetailUrl(conversationId), config, {
    Referer: `${BASE_URL}/c/${conversationId}`,
    "X-OpenAI-Target-Path": targetPath,
    "X-OpenAI-Target-Route": "/backend-api/conversation/{conversation_id}"
  });

  return normalizeConversationDetail(payload, conversationId, fallback);
}
