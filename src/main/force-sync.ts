import { App, MarkdownView, Notice, TFile, TFolder } from "obsidian";

import { fetchConversationDetailWithPayload, parseConversationDetailPayload, validateConversationListAccess } from "../chatgpt/api";
import { isChatGptRequestError } from "../chatgpt/request-core";
import { createSingleConversationNoteIndex, upsertConversationNote } from "../storage/note-writer";
import { resolveAssetFolderPaths } from "../storage/asset-storage";
import { cleanupMovedConversationFolders } from "./folder-cleanup";
import { findMigratableLegacyAssetFileName, findReusableLocalAssetFileName } from "./asset-local-match";
import { CONVERSATION_ID_KEY, formatActionLabel } from "./helpers";
import type {
  ChatGptRequestConfig,
  ConversationAssetLinkMap,
  ConversationDetail,
  StoredSessionAccount,
} from "../shared/types";
import type { ConversationFrontmatterInfo } from "./helpers";

type ForceSyncResult = {
  action: "created" | "updated" | "skipped";
  filePath: string;
  moved: boolean;
  previousFilePath?: string;
};

export interface ForceSyncHostContext {
  app: App;
  settings: {
    assetStorageMode: "global_by_conversation" | "with_conversation";
    defaultFolder: string;
    conversationPathTemplate: string;
    saveConversationJson: boolean;
  };
  manifest: {
    version: string;
  };
  isSyncWorkerActive(): boolean;
  setSyncWorkerActive(value: boolean): void;
  setSuppressSyncStatusBarUpdates(value: boolean): void;
  getConversationFrontmatter(file: TFile): ConversationFrontmatterInfo;
  resolveAccountForConversation(frontmatter: ConversationFrontmatterInfo): StoredSessionAccount;
  getRequestConfig(account: StoredSessionAccount): ChatGptRequestConfig;
  getAccountLabel(account: StoredSessionAccount): string;
  readConversationJsonSidecar(notePath: string): Promise<unknown | null>;
  saveConversationJsonSidecar(notePath: string, payload: unknown): Promise<string>;
  moveConversationJsonSidecar(sourceNotePath: string, targetNotePath: string): Promise<boolean>;
  syncConversationAssets(
    requestConfig: ChatGptRequestConfig,
    conversation: ConversationDetail,
    baseFolder: string,
    conversationPathTemplate: string,
    assetStorageMode: "global_by_conversation" | "with_conversation",
    logger: null,
    accountLabel: string,
    conversationIndex: number,
    totalConversations: number,
    stopSignal?: AbortSignal,
  ): Promise<ConversationAssetLinkMap>;
  setSyncStatusBar(text: string, active?: boolean): void;
  clearSyncStatusBar(delayMs?: number): void;
  logInfo(message: string, context?: unknown): void;
  logWarn(message: string, context?: unknown): void;
}

function shouldUseCachedJsonFallbackForForceSync(error: unknown): boolean {
  return isChatGptRequestError(error) && error.status >= 400 && error.status < 500 && error.status !== 429;
}

function collectUniqueConversationAssetReferences(
  conversation: ConversationDetail,
): Array<{ fileId: string; logicalName: string }> {
  const refsById = new Map<string, { fileId: string; logicalName: string }>();

  for (const reference of conversation.fileReferences) {
    if (!refsById.has(reference.fileId)) {
      refsById.set(reference.fileId, {
        fileId: reference.fileId,
        logicalName: reference.logicalName,
      });
    }
  }

  return Array.from(refsById.values());
}

function findLocalAssetLinkInFolder(
  host: ForceSyncHostContext,
  folderPath: string,
  ref: { fileId: string; logicalName: string },
): { path: string; fileName: string } | null {
  const folder = host.app.vault.getAbstractFileByPath(folderPath);

  if (!(folder instanceof TFolder)) {
    return null;
  }

  const files = folder.children.filter((child): child is TFile => child instanceof TFile);
  const fileNames = files.map((entry) => entry.name);
  const reusableName = findReusableLocalAssetFileName(fileNames, ref);
  const legacyName = reusableName ? null : findMigratableLegacyAssetFileName(fileNames, ref);
  const matchedName = reusableName ?? legacyName;

  if (!matchedName) {
    return null;
  }

  const matchedFile = files.find((entry) => entry.name === matchedName);
  if (!matchedFile) {
    return null;
  }

  return {
    path: matchedFile.path,
    fileName: matchedFile.name,
  };
}

function resolveCachedConversationAssetLinks(
  host: ForceSyncHostContext,
  requestConfig: ChatGptRequestConfig,
  conversation: ConversationDetail,
): ConversationAssetLinkMap {
  const refs = collectUniqueConversationAssetReferences(conversation);
  if (refs.length === 0) {
    return {};
  }

  const folderPaths = resolveAssetFolderPaths({
    mode: host.settings.assetStorageMode,
    baseFolder: host.settings.defaultFolder,
    conversationPathTemplate: host.settings.conversationPathTemplate,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    account: {
      accountId: requestConfig.accountId,
      email: requestConfig.userEmail,
    },
  });
  const searchFolderPaths = Array.from(
    new Set([
      folderPaths.targetFolderPath,
      folderPaths.globalFolderPath,
      folderPaths.localFolderPath,
      ...folderPaths.candidateFolderPaths,
    ]),
  );
  const linkMap: ConversationAssetLinkMap = {};

  for (const ref of refs) {
    for (const folderPath of searchFolderPaths) {
      const matched = findLocalAssetLinkInFolder(host, folderPath, ref);
      if (!matched) {
        continue;
      }

      linkMap[ref.fileId] = matched;
      break;
    }
  }

  return linkMap;
}

async function handleForceSyncNoteMove(
  host: ForceSyncHostContext,
  result: {
    moved: boolean;
    previousFilePath?: string;
    filePath: string;
  },
  conversationId: string,
): Promise<void> {
  if (!result.moved || !result.previousFilePath) {
    return;
  }

  try {
    await host.moveConversationJsonSidecar(result.previousFilePath, result.filePath);
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    host.logWarn("JSON sidecar move warning", {
      conversationId,
      warning,
    });
  }

  try {
    const removedFolders = await cleanupMovedConversationFolders(
      host.app,
      result.previousFilePath,
      result.filePath,
      host.settings.assetStorageMode,
    );
    removedFolders.forEach((folderPath) => {
      host.logInfo("Removed empty conversation folder", {
        conversationId,
        folderPath,
      });
    });
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    host.logWarn("Conversation folder cleanup warning", {
      conversationId,
      warning,
    });
  }
}

async function forceSyncConversationFromCachedJson(
  host: ForceSyncHostContext,
  file: TFile,
  frontmatter: ConversationFrontmatterInfo,
  requestConfig: ChatGptRequestConfig,
  activeEditorContext?: { editor: MarkdownView["editor"]; filePath: string },
): Promise<{
  detail: ConversationDetail;
  result: ForceSyncResult;
}> {
  const rawPayload = await host.readConversationJsonSidecar(file.path);

  if (rawPayload === null) {
    throw new Error(
      `Cached JSON sidecar not found for "${file.path}". Run full sync with "Save conversation JSON" enabled first.`,
    );
  }

  const fallbackSummary = {
    title: frontmatter.title || file.basename || "Untitled Conversation",
    createdAt: frontmatter.createdAt || frontmatter.updatedAt || "",
    updatedAt: frontmatter.updatedAt || frontmatter.createdAt || "",
  };
  const detail = parseConversationDetailPayload(rawPayload, frontmatter.conversationId, fallbackSummary);
  const assetLinks = resolveCachedConversationAssetLinks(host, requestConfig, detail);
  const noteIndex = createSingleConversationNoteIndex(requestConfig.accountId, detail.id, file);
  const result = await upsertConversationNote(
    host.app,
    noteIndex,
    detail,
    host.settings.defaultFolder,
    {
      accountId: requestConfig.accountId,
      userId: requestConfig.userId,
      userEmail: requestConfig.userEmail,
    },
    host.manifest.version,
    host.settings.conversationPathTemplate,
    host.settings.assetStorageMode,
    frontmatter.listUpdatedAt || detail.updatedAt,
    assetLinks,
    true,
    activeEditorContext,
  );

  await handleForceSyncNoteMove(host, result, detail.id);
  return {
    detail,
    result,
  };
}

export async function forceSyncConversationNote(host: ForceSyncHostContext, file: TFile): Promise<void> {
  if (host.isSyncWorkerActive()) {
    new Notice("A sync job is already running. Wait for it to finish.");
    return;
  }

  const frontmatter = host.getConversationFrontmatter(file);
  if (!frontmatter.conversationId) {
    new Notice(`Current note is missing ${CONVERSATION_ID_KEY} in frontmatter.`);
    return;
  }

  let account: StoredSessionAccount;
  try {
    account = host.resolveAccountForConversation(frontmatter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(message);
    return;
  }

  let requestConfig: ChatGptRequestConfig;
  try {
    requestConfig = host.getRequestConfig(account);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(message);
    return;
  }

  const accountLabel = host.getAccountLabel(account);
  const activeView = host.app.workspace.getActiveViewOfType(MarkdownView);
  const activeEditorContext =
    activeView?.editor && activeView.file?.path === file.path
      ? {
          editor: activeView.editor,
          filePath: activeView.file.path,
        }
      : undefined;
  const fallbackSummary = {
    id: frontmatter.conversationId,
    title: frontmatter.title || file.basename || "Untitled Conversation",
    createdAt: frontmatter.createdAt || frontmatter.updatedAt || "",
    updatedAt: frontmatter.updatedAt || frontmatter.createdAt || "",
  };

  host.setSyncWorkerActive(true);
  host.setSuppressSyncStatusBarUpdates(false);
  host.setSyncStatusBar(`ChatGPT sync: forcing ${fallbackSummary.title}`, true);

  try {
    let useCachedJsonFallback = false;
    let fallbackReason: string | null = null;

    try {
      await validateConversationListAccess(requestConfig);
    } catch (error) {
      if (!shouldUseCachedJsonFallbackForForceSync(error)) {
        throw error;
      }

      useCachedJsonFallback = true;
      fallbackReason = error instanceof Error ? error.message : String(error);
      host.logWarn("Force sync validation warning: rebuilding from cached JSON", {
        conversationId: frontmatter.conversationId,
        accountId: requestConfig.accountId,
        accountLabel,
        warning: fallbackReason,
      });
      host.setSyncStatusBar(`ChatGPT sync: account unavailable, rebuilding ${fallbackSummary.title} from cache`, true);
    }

    let detail: ConversationDetail;
    let result: ForceSyncResult;

    if (useCachedJsonFallback) {
      ({ detail, result } = await forceSyncConversationFromCachedJson(
        host,
        file,
        frontmatter,
        requestConfig,
        activeEditorContext,
      ));
    } else {
      const detailResult = await fetchConversationDetailWithPayload(
        requestConfig,
        frontmatter.conversationId,
        fallbackSummary,
      );
      detail = detailResult.detail;
      const assetLinks = await host.syncConversationAssets(
        requestConfig,
        detail,
        host.settings.defaultFolder,
        host.settings.conversationPathTemplate,
        host.settings.assetStorageMode,
        null,
        accountLabel,
        1,
        1,
      );
      const noteIndex = createSingleConversationNoteIndex(requestConfig.accountId, detail.id, file);
      result = await upsertConversationNote(
        host.app,
        noteIndex,
        detail,
        host.settings.defaultFolder,
        {
          accountId: requestConfig.accountId,
          userId: requestConfig.userId,
          userEmail: requestConfig.userEmail,
        },
        host.manifest.version,
        host.settings.conversationPathTemplate,
        host.settings.assetStorageMode,
        frontmatter.listUpdatedAt || detail.updatedAt,
        assetLinks,
        true,
        activeEditorContext,
      );
      await handleForceSyncNoteMove(host, result, detail.id);

      if (host.settings.saveConversationJson) {
        try {
          await host.saveConversationJsonSidecar(result.filePath, detailResult.rawPayload);
        } catch (error) {
          const warning = error instanceof Error ? error.message : String(error);
          host.logWarn("JSON sidecar save warning", {
            conversationId: detail.id,
            warning,
          });
        }
      }
    }

    const actionLabel = `${formatActionLabel(result.action)}${result.moved ? " + moved" : ""}`;
    const statusSuffix = useCachedJsonFallback ? " from cached JSON" : "";
    host.setSyncStatusBar(`ChatGPT sync: ${actionLabel.toLowerCase()} "${detail.title}"${statusSuffix}`, false);
    host.clearSyncStatusBar(6000);
    if (useCachedJsonFallback) {
      const reasonSuffix = fallbackReason ? ` (${fallbackReason})` : "";
      new Notice(`Chats2MD ${actionLabel} from cached JSON: ${detail.title}${reasonSuffix}`);
    } else {
      new Notice(`Chats2MD ${actionLabel}: ${detail.title}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    host.setSyncStatusBar(`ChatGPT sync failed: ${message}`, false);
    host.clearSyncStatusBar(10000);
    new Notice(`Chats2MD force sync failed: ${message}`);
  } finally {
    host.setSyncWorkerActive(false);
  }
}
