import { App, normalizePath, TFile, TFolder } from "obsidian";
import { getDateBucketFromTimestamp, slugifyConversationTitle } from "./conversation-utils";

import type { ConversationDetail, ConversationUpsertResult } from "./types";

const CONVERSATION_ID_KEY = "chatgpt_conversation_id";
const CONVERSATION_TITLE_KEY = "chatgpt_title";
const CONVERSATION_UPDATED_AT_KEY = "chatgpt_updated_at";
const CONVERSATION_ACCOUNT_ID_KEY = "chatgpt_account_id";

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function getFolderPathFromFile(file: TFile): string {
  const index = file.path.lastIndexOf("/");
  return index === -1 ? "" : file.path.slice(0, index);
}

function joinPath(folder: string, fileName: string): string {
  return normalizePath(`${folder}/${fileName}`);
}

async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);

  if (normalized.length === 0) {
    return;
  }

  const parts = normalized.split("/");
  let current = "";

  for (const part of parts) {
    current = current.length === 0 ? part : `${current}/${part}`;
    const existing = app.vault.getAbstractFileByPath(current);

    if (!existing) {
      await app.vault.createFolder(current);
      continue;
    }

    if (!(existing instanceof TFolder)) {
      throw new Error(`Target folder path "${normalized}" conflicts with an existing file.`);
    }
  }
}

function buildFrontmatter(
  conversation: ConversationDetail,
  importedAt: string,
  account: { accountId: string; userId: string; userEmail: string },
  pluginVersion: string
): string {
  const rows = [
    "---",
    `${CONVERSATION_ID_KEY}: ${quoteYaml(conversation.id)}`,
    `chatgpt_title: ${quoteYaml(conversation.title)}`,
    `chatgpt_created_at: ${quoteYaml(conversation.createdAt)}`,
    `chatgpt_updated_at: ${quoteYaml(conversation.updatedAt)}`,
    `chatgpt_imported_at: ${quoteYaml(importedAt)}`,
    `chatgpt_url: ${quoteYaml(conversation.url)}`,
    `${CONVERSATION_ACCOUNT_ID_KEY}: ${quoteYaml(account.accountId)}`,
    `chatgpt_user_id: ${quoteYaml(account.userId)}`,
    `chatgpt_user_email: ${quoteYaml(account.userEmail)}`,
    `chats2md_source: ${quoteYaml("backend-api/conversation")}`,
    `chats2md_plugin_version: ${quoteYaml(pluginVersion)}`,
    "---"
  ];

  return rows.join("\n");
}

function buildTranscript(conversation: ConversationDetail): string {
  if (conversation.messages.length === 0) {
    return "_No visible user or assistant messages were available in this conversation._";
  }

  return conversation.messages.map((message) => message.markdown.trim()).join("\n\n");
}

function buildBody(conversation: ConversationDetail): string {
  return [
    `# ${conversation.title}`,
    "",
    buildTranscript(conversation)
  ].join("\n");
}

function buildNoteContent(
  conversation: ConversationDetail,
  importedAt: string,
  account: { accountId: string; userId: string; userEmail: string },
  pluginVersion: string
): string {
  return `${buildFrontmatter(conversation, importedAt, account, pluginVersion)}\n\n${buildBody(conversation)}\n`;
}

function normalizeTargetFolder(folder: string): string {
  return normalizePath(folder.trim().replace(/^\/+|\/+$/g, ""));
}

async function findAvailablePath(app: App, desiredPath: string, currentPath?: string): Promise<string> {
  if (currentPath === desiredPath) {
    return desiredPath;
  }

  if (!app.vault.getAbstractFileByPath(desiredPath)) {
    return desiredPath;
  }

  const extension = ".md";
  const basePath = desiredPath.endsWith(extension) ? desiredPath.slice(0, -extension.length) : desiredPath;
  let counter = 2;

  while (true) {
    const candidate = `${basePath}-${counter}${extension}`;

    if (candidate === currentPath || !app.vault.getAbstractFileByPath(candidate)) {
      return candidate;
    }

    counter += 1;
  }
}

function readFrontmatterString(app: App, file: TFile, key: string): string {
  const value = app.metadataCache.getFileCache(file)?.frontmatter?.[key];
  return typeof value === "string" ? value : "";
}

function buildConversationKey(accountId: string, conversationId: string): string {
  return `${accountId}::${conversationId}`;
}

export function indexConversationNotes(app: App): Map<string, TFile> {
  const notes = new Map<string, TFile>();

  for (const file of app.vault.getMarkdownFiles()) {
    const conversationId = readFrontmatterString(app, file, CONVERSATION_ID_KEY);
    const accountId = readFrontmatterString(app, file, CONVERSATION_ACCOUNT_ID_KEY);
    const key = buildConversationKey(accountId, conversationId);

    if (conversationId && !notes.has(key)) {
      notes.set(key, file);
    }
  }

  return notes;
}

export async function upsertConversationNote(
  app: App,
  noteIndex: Map<string, TFile>,
  conversation: ConversationDetail,
  folder: string,
  account: { accountId: string; userId: string; userEmail: string },
  pluginVersion: string
): Promise<ConversationUpsertResult> {
  const normalizedFolder = normalizeTargetFolder(folder);

  if (normalizedFolder.length === 0) {
    throw new Error("A vault folder is required.");
  }

  await ensureFolderExists(app, normalizedFolder);

  const dateFolder = getDateBucketFromTimestamp(conversation.updatedAt);
  const targetFolder = normalizePath(`${normalizedFolder}/${dateFolder}`);
  await ensureFolderExists(app, targetFolder);

  const fileName = `${slugifyConversationTitle(conversation.title)}.md`;
  const noteKey = buildConversationKey(account.accountId, conversation.id);
  const existing = noteIndex.get(noteKey);

  if (!existing) {
    const desiredPath = await findAvailablePath(app, joinPath(targetFolder, fileName));
    const importedAt = new Date().toISOString();
    const createdFile = await app.vault.create(
      desiredPath,
      buildNoteContent(conversation, importedAt, account, pluginVersion)
    );
    noteIndex.set(noteKey, createdFile);

    return {
      action: "created",
      filePath: createdFile.path,
      moved: false
    };
  }

  const desiredPath = await findAvailablePath(app, joinPath(targetFolder, fileName), existing.path);
  let moved = false;

  if (desiredPath !== existing.path) {
    await app.fileManager.renameFile(existing, desiredPath);
    moved = true;
  }

  const existingUpdatedAt = readFrontmatterString(app, existing, CONVERSATION_UPDATED_AT_KEY);
  const existingTitle = readFrontmatterString(app, existing, CONVERSATION_TITLE_KEY);
  const shouldRewrite = existingUpdatedAt !== conversation.updatedAt || existingTitle !== conversation.title;

  if (!shouldRewrite) {
    return {
      action: "skipped",
      filePath: existing.path,
      moved
    };
  }

  const importedAt = new Date().toISOString();
  await app.vault.modify(existing, buildNoteContent(conversation, importedAt, account, pluginVersion));

  return {
    action: "updated",
    filePath: existing.path,
    moved
  };
}
