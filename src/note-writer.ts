import { App, normalizePath, TFile, TFolder } from "obsidian";
import { normalizeAssetStorageMode } from "./main-helpers";
import { resolveConversationNoteRelativePath } from "./path-template";

import type {
  AssetStorageMode,
  ConversationAssetLinkMap,
  ConversationDetail,
  ConversationFileReference,
  ConversationFileReferenceKind,
  ConversationUpsertResult
} from "./types";

const CONVERSATION_ID_KEY = "chatgpt_conversation_id";
const CONVERSATION_TITLE_KEY = "chatgpt_title";
const CONVERSATION_UPDATED_AT_KEY = "chatgpt_updated_at";
const CONVERSATION_LIST_UPDATED_AT_KEY = "chatgpt_list_updated_at";
const CONVERSATION_ACCOUNT_ID_KEY = "chatgpt_account_id";
const CONVERSATION_ASSET_STORAGE_MODE_KEY = "chats2md_asset_storage";

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function getFolderPathFromFile(file: TFile): string {
  const index = file.path.lastIndexOf("/");
  return index === -1 ? "" : file.path.slice(0, index);
}

function getFolderPathFromFilePath(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? "" : filePath.slice(0, index);
}

function joinPath(folder: string, fileName: string): string {
  return normalizePath(`${folder}/${fileName}`);
}

function toRelativePath(fromFilePath: string, targetPath: string): string {
  const fromDir = getFolderPathFromFilePath(fromFilePath);
  const fromParts = fromDir.length > 0 ? fromDir.split("/") : [];
  const targetParts = targetPath.split("/");

  let shared = 0;
  while (shared < fromParts.length && shared < targetParts.length && fromParts[shared] === targetParts[shared]) {
    shared += 1;
  }

  const upSegments = fromParts.slice(shared).map(() => "..");
  const downSegments = targetParts.slice(shared);
  const relativeParts = [...upSegments, ...downSegments];

  return relativeParts.length > 0 ? relativeParts.join("/") : ".";
}

function encodeMarkdownLinkPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\[\]]/g, "\\$&");
}

function referenceKey(kind: ConversationFileReferenceKind, fileId: string): string {
  return `${kind}:${fileId}`;
}

function buildReferenceIndex(conversation: ConversationDetail): Map<string, ConversationFileReference> {
  const index = new Map<string, ConversationFileReference>();

  for (const reference of conversation.fileReferences) {
    const key = referenceKey(reference.kind, reference.fileId);
    if (!index.has(key)) {
      index.set(key, reference);
    }
  }

  return index;
}

function renderPlaceholderReplacement(
  reference: ConversationFileReference,
  notePath: string,
  assetLinks: ConversationAssetLinkMap
): string {
  const resolved = assetLinks[reference.fileId];

  if (!resolved) {
    return `[missing file: ${reference.fileId}]`;
  }

  const label = escapeMarkdownLabel(reference.logicalName.trim().length > 0 ? reference.logicalName : reference.fileId);
  const relativePath = encodeMarkdownLinkPath(toRelativePath(notePath, resolved.path));

  if (reference.kind === "image") {
    return `![${label}](${relativePath})`;
  }

  return `[${label}](${relativePath})`;
}

function injectAssetLinksIntoMarkdown(
  markdown: string,
  notePath: string,
  references: Map<string, ConversationFileReference>,
  assetLinks: ConversationAssetLinkMap
): string {
  let transformed = markdown;

  for (const reference of references.values()) {
    if (!transformed.includes(reference.placeholder)) {
      continue;
    }

    transformed = transformed.split(reference.placeholder).join(
      renderPlaceholderReplacement(reference, notePath, assetLinks)
    );
  }

  return transformed;
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
  listUpdatedAt: string,
  importedAt: string,
  account: { accountId: string; userId: string; userEmail: string },
  pluginVersion: string,
  assetStorageMode: AssetStorageMode
): string {
  const rows = [
    "---",
    `${CONVERSATION_ID_KEY}: ${quoteYaml(conversation.id)}`,
    `chatgpt_title: ${quoteYaml(conversation.title)}`,
    `chatgpt_created_at: ${quoteYaml(conversation.createdAt)}`,
    `chatgpt_updated_at: ${quoteYaml(conversation.updatedAt)}`,
    `${CONVERSATION_LIST_UPDATED_AT_KEY}: ${quoteYaml(listUpdatedAt)}`,
    `chatgpt_imported_at: ${quoteYaml(importedAt)}`,
    `chatgpt_url: ${quoteYaml(conversation.url)}`,
    `${CONVERSATION_ACCOUNT_ID_KEY}: ${quoteYaml(account.accountId)}`,
    `chatgpt_user_id: ${quoteYaml(account.userId)}`,
    `chatgpt_user_email: ${quoteYaml(account.userEmail)}`,
    `${CONVERSATION_ASSET_STORAGE_MODE_KEY}: ${quoteYaml(assetStorageMode)}`,
    `chats2md_source: ${quoteYaml("backend-api/conversation")}`,
    `chats2md_plugin_version: ${quoteYaml(pluginVersion)}`,
    "---"
  ];

  return rows.join("\n");
}

function buildTranscript(
  conversation: ConversationDetail,
  notePath: string,
  assetLinks: ConversationAssetLinkMap
): string {
  if (conversation.messages.length === 0) {
    return "_No visible user or assistant messages were available in this conversation._";
  }

  const references = buildReferenceIndex(conversation);

  return conversation.messages
    .map((message) => injectAssetLinksIntoMarkdown(message.markdown.trim(), notePath, references, assetLinks))
    .join("\n\n");
}

function buildBody(
  conversation: ConversationDetail,
  notePath: string,
  assetLinks: ConversationAssetLinkMap
): string {
  return [
    `# ${conversation.title}`,
    "",
    buildTranscript(conversation, notePath, assetLinks)
  ].join("\n");
}

function buildNoteContent(
  conversation: ConversationDetail,
  listUpdatedAt: string,
  importedAt: string,
  account: { accountId: string; userId: string; userEmail: string },
  pluginVersion: string,
  assetStorageMode: AssetStorageMode,
  notePath: string,
  assetLinks: ConversationAssetLinkMap
): string {
  return `${buildFrontmatter(conversation, listUpdatedAt, importedAt, account, pluginVersion, assetStorageMode)}\n\n${buildBody(conversation, notePath, assetLinks)}\n`;
}

function normalizeTargetFolder(folder: string): string {
  return normalizePath(folder.trim().replace(/^\/+|\/+$/g, ""));
}

function buildConversationDesiredPath(
  folder: string,
  conversationPathTemplate: string,
  conversation: { id: string; title: string; updatedAt: string },
  account: { accountId: string; userId: string; userEmail: string }
): string {
  const relativePath = resolveConversationNoteRelativePath(conversationPathTemplate, {
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    conversationId: conversation.id,
    email: account.userEmail,
    accountId: account.accountId
  });
  return normalizePath(`${folder}/${relativePath}`);
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

export function getIndexedConversationSyncMetadata(
  app: App,
  noteIndex: Map<string, TFile>,
  accountId: string,
  conversationId: string
): { updatedAt: string | null; listUpdatedAt: string | null; title: string | null; assetStorageMode: AssetStorageMode | null } {
  const noteKey = buildConversationKey(accountId, conversationId);
  const legacyKey = buildConversationKey("", conversationId);
  const existing = noteIndex.get(noteKey) ?? noteIndex.get(legacyKey);

  if (!existing) {
    return {
      updatedAt: null,
      listUpdatedAt: null,
      title: null,
      assetStorageMode: null
    };
  }

  const updatedAt = readFrontmatterString(app, existing, CONVERSATION_UPDATED_AT_KEY).trim();
  const listUpdatedAt = readFrontmatterString(app, existing, CONVERSATION_LIST_UPDATED_AT_KEY).trim();
  const title = readFrontmatterString(app, existing, CONVERSATION_TITLE_KEY).trim();
  const storedAssetMode = readFrontmatterString(app, existing, CONVERSATION_ASSET_STORAGE_MODE_KEY).trim();

  return {
    updatedAt: updatedAt.length > 0 ? updatedAt : null,
    listUpdatedAt: listUpdatedAt.length > 0 ? listUpdatedAt : null,
    title: title.length > 0 ? title : null,
    assetStorageMode: storedAssetMode.length > 0 ? normalizeAssetStorageMode(storedAssetMode) : null
  };
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

export async function ensureConversationNotePath(
  app: App,
  noteIndex: Map<string, TFile>,
  conversation: { id: string; title: string; updatedAt: string },
  folder: string,
  account: { accountId: string; userId: string; userEmail: string },
  conversationPathTemplate: string
): Promise<{ moved: boolean; filePath: string | null; previousFilePath?: string }> {
  const noteKey = buildConversationKey(account.accountId, conversation.id);
  const legacyKey = buildConversationKey("", conversation.id);
  const existing = noteIndex.get(noteKey) ?? noteIndex.get(legacyKey);

  if (!existing) {
    return {
      moved: false,
      filePath: null
    };
  }

  if (!noteIndex.has(noteKey)) {
    noteIndex.set(noteKey, existing);
  }

  const normalizedFolder = normalizeTargetFolder(folder);

  if (normalizedFolder.length === 0) {
    throw new Error("A vault folder is required.");
  }

  await ensureFolderExists(app, normalizedFolder);

  const desiredByTemplate = buildConversationDesiredPath(
    normalizedFolder,
    conversationPathTemplate,
    conversation,
    account
  );
  const targetFolder = getFolderPathFromFilePath(desiredByTemplate);
  await ensureFolderExists(app, targetFolder);
  const desiredPath = await findAvailablePath(app, desiredByTemplate, existing.path);

  if (desiredPath === existing.path) {
    return {
      moved: false,
      filePath: existing.path
    };
  }

  const previousFilePath = existing.path;
  await app.fileManager.renameFile(existing, desiredPath);

  return {
    moved: true,
    filePath: desiredPath,
    previousFilePath
  };
}

export async function upsertConversationNote(
  app: App,
  noteIndex: Map<string, TFile>,
  conversation: ConversationDetail,
  folder: string,
  account: { accountId: string; userId: string; userEmail: string },
  pluginVersion: string,
  conversationPathTemplate: string,
  assetStorageMode: AssetStorageMode,
  listUpdatedAt?: string,
  assetLinks: ConversationAssetLinkMap = {},
  forceRewrite = false
): Promise<ConversationUpsertResult> {
  const normalizedFolder = normalizeTargetFolder(folder);
  const normalizedListUpdatedAt = (listUpdatedAt ?? conversation.updatedAt).trim() || conversation.updatedAt;

  if (normalizedFolder.length === 0) {
    throw new Error("A vault folder is required.");
  }

  const desiredByTemplate = buildConversationDesiredPath(
    normalizedFolder,
    conversationPathTemplate,
    conversation,
    account
  );
  const targetFolder = getFolderPathFromFilePath(desiredByTemplate);
  await ensureFolderExists(app, targetFolder);
  const noteKey = buildConversationKey(account.accountId, conversation.id);
  const existing = noteIndex.get(noteKey);

  if (!existing) {
    const desiredPath = await findAvailablePath(app, desiredByTemplate);
    const importedAt = new Date().toISOString();
    const createdFile = await app.vault.create(
      desiredPath,
      buildNoteContent(conversation, normalizedListUpdatedAt, importedAt, account, pluginVersion, assetStorageMode, desiredPath, assetLinks)
    );
    noteIndex.set(noteKey, createdFile);

    return {
      action: "created",
      filePath: createdFile.path,
      moved: false
    };
  }

  const desiredPath = await findAvailablePath(app, desiredByTemplate, existing.path);
  let moved = false;
  let previousFilePath: string | undefined;

  if (desiredPath !== existing.path) {
    previousFilePath = existing.path;
    await app.fileManager.renameFile(existing, desiredPath);
    moved = true;
  }

  const existingUpdatedAt = readFrontmatterString(app, existing, CONVERSATION_UPDATED_AT_KEY);
  const existingTitle = readFrontmatterString(app, existing, CONVERSATION_TITLE_KEY);
  const existingListUpdatedAt = readFrontmatterString(app, existing, CONVERSATION_LIST_UPDATED_AT_KEY);
  const existingAssetStorageMode = normalizeAssetStorageMode(readFrontmatterString(app, existing, CONVERSATION_ASSET_STORAGE_MODE_KEY));
  const shouldRewrite = forceRewrite
    || existingUpdatedAt !== conversation.updatedAt
    || existingTitle !== conversation.title
    || existingListUpdatedAt !== normalizedListUpdatedAt
    || existingAssetStorageMode !== assetStorageMode;

  if (!shouldRewrite) {
    return {
      action: "skipped",
      filePath: existing.path,
      moved,
      previousFilePath
    };
  }

  const importedAt = new Date().toISOString();
  await app.vault.modify(
    existing,
    buildNoteContent(conversation, normalizedListUpdatedAt, importedAt, account, pluginVersion, assetStorageMode, existing.path, assetLinks)
  );

  return {
    action: "updated",
    filePath: existing.path,
    moved,
    previousFilePath
  };
}
