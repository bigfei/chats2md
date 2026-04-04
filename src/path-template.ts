import { getDateBucketFromTimestamp, slugifyConversationTitle } from "./conversation-utils";
import { sanitizePathPart } from "./main-helpers";

const SUPPORTED_PLACEHOLDERS = new Set([
  "date",
  "slug",
  "email",
  "user_id",
  "conversation_id"
]);

export interface ConversationPathTemplateContext {
  title: string;
  updatedAt: string;
  conversationId: string;
  email: string;
  userId: string;
}

function normalizeTemplate(template: string): string {
  return normalizeVaultPath(template.trim().replace(/^\/+|\/+$/g, ""));
}

function normalizeVaultPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function readPlaceholderValue(name: string, context: ConversationPathTemplateContext): string {
  switch (name) {
    case "date":
      return getDateBucketFromTimestamp(context.updatedAt);
    case "slug":
      return slugifyConversationTitle(context.title);
    case "email":
      return context.email.trim() || "unknown-email";
    case "user_id":
      return context.userId.trim() || "unknown-user";
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

  const resolvedPath = normalizeVaultPath(
    normalizedTemplate.replace(/\{([^}]+)\}/g, (_, name: string) => readPlaceholderValue(name, context))
  );
  const segments = resolvedPath.split("/");

  if (segments.some((segment) => segment.trim().length === 0)) {
    throw new Error("Conversation path template produced an invalid empty path segment.");
  }

  const sanitizedPath = normalizeVaultPath(segments.map((segment) => sanitizePathPart(segment)).join("/"));

  if (!sanitizedPath || sanitizedPath === "." || sanitizedPath === "..") {
    throw new Error("Conversation path template produced an invalid output path.");
  }

  return `${sanitizedPath}.md`;
}

export const CONVERSATION_PATH_TEMPLATE_PRESETS = [
  "{date}/{slug}",
  "{email}/{user_id}/{date}/{slug}",
  "{email}/{user_id}/{slug}"
] as const;
