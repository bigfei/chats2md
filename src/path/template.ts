import { getDateBucketFromTimestamp, slugifyConversationTitle } from "../chatgpt/conversation-utils";
import { sanitizePathPart } from "../main/helpers";
import { normalizeObsidianPath } from "./normalization";

const SUPPORTED_PLACEHOLDERS = new Set([
  "date",
  "slug",
  "email",
  "account_id",
  "conversation_id"
]);

export interface ConversationPathTemplateContext {
  title: string;
  updatedAt: string;
  conversationId: string;
  email: string;
  accountId: string;
}

function normalizeTemplate(template: string): string {
  const trimmed = template.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.length > 0 ? normalizeObsidianPath(trimmed) : "";
}

function readPlaceholderValue(name: string, context: ConversationPathTemplateContext): string {
  switch (name) {
    case "date":
      return getDateBucketFromTimestamp(context.updatedAt);
    case "slug":
      return slugifyConversationTitle(context.title);
    case "email":
      return context.email.trim() || "unknown-email";
    case "account_id":
      return context.accountId.trim() || "unknown-account";
    case "conversation_id":
      return context.conversationId.trim() || "unknown-conversation";
    default:
      return "";
  }
}

export function resolveConversationNoteRelativePath(
  template: string,
  context: ConversationPathTemplateContext
): string {
  const normalizedTemplate = normalizeTemplate(template);

  if (!normalizedTemplate) {
    throw new Error("Conversation path template cannot be empty.");
  }

  if (normalizedTemplate.toLowerCase().endsWith(".md")) {
    throw new Error("Conversation path template should not include the .md extension.");
  }

  const unknownPlaceholders = Array.from(normalizedTemplate.matchAll(/\{([^}]+)\}/g))
    .map((match) => match[1])
    .filter((name): name is string => typeof name === "string" && !SUPPORTED_PLACEHOLDERS.has(name));

  if (unknownPlaceholders.length > 0) {
    throw new Error(`Conversation path template contains unsupported placeholder(s): ${unknownPlaceholders.join(", ")}`);
  }

  const resolvedPath = normalizeObsidianPath(
    normalizedTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => readPlaceholderValue(name, context))
  );
  const segments = resolvedPath.split("/");

  if (segments.some((segment) => segment.trim().length === 0)) {
    throw new Error("Conversation path template produced an invalid empty path segment.");
  }

  const sanitizedPath = normalizeObsidianPath(segments.map((segment) => sanitizePathPart(segment)).join("/"));

  if (!sanitizedPath || sanitizedPath === "." || sanitizedPath === "..") {
    throw new Error("Conversation path template produced an invalid output path.");
  }

  return `${sanitizedPath}.md`;
}

export const CONVERSATION_PATH_TEMPLATE_PRESETS = [
  "{date}/{slug}",
  "{email}/{account_id}/{date}/{slug}",
  "{email}/{account_id}/{slug}"
] as const;
