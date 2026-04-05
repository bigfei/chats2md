import { App, TFile, TFolder, normalizePath } from "obsidian";

import { resolveAssetFolderPaths } from "../storage/asset-storage";
import { fetchConversationFileDownloadInfo, fetchSignedFileContent } from "../chatgpt/api";
import {
  appendExtensionIfMissing,
  formatAssetStorageMode,
  sanitizePathPart,
  type SyncRunLogger
} from "./helpers";
import type {
  AssetStorageMode,
  ChatGptRequestConfig,
  ConversationAssetLinkMap,
  ConversationDetail,
  ConversationFileReference
} from "../shared/types";

export interface MainAssetSyncHost {
  app: App;
  ensureFolderExists(folderPath: string): Promise<void>;
}

export interface SyncConversationAssetsParams {
  requestConfig: ChatGptRequestConfig;
  conversation: ConversationDetail;
  baseFolder: string;
  conversationPathTemplate: string;
  assetStorageMode: AssetStorageMode;
  logger: SyncRunLogger | null;
  accountLabel: string;
  conversationIndex: number;
  totalConversations: number;
}

function readFolderFileNames(app: App, folderPath: string): Set<string> {
  const names = new Set<string>();
  const folder = app.vault.getAbstractFileByPath(folderPath);

  if (!(folder instanceof TFolder)) {
    return names;
  }

  for (const child of folder.children) {
    if (child instanceof TFile) {
      names.add(child.name);
    }
  }

  return names;
}

function nextAvailableFileName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  const dotIndex = baseName.lastIndexOf(".");
  const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
  const extension = dotIndex > 0 ? baseName.slice(dotIndex) : "";
  let suffix = 1;

  while (true) {
    const candidate = `${stem}_${suffix}${extension}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    suffix += 1;
  }
}

function extractKnownExtension(fileName: string): string | null {
  const trimmed = fileName.trim();
  const dotIndex = trimmed.lastIndexOf(".");

  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) {
    return null;
  }

  const extension = trimmed.slice(dotIndex).toLowerCase();
  return /^[.][a-z0-9]{1,12}$/i.test(extension) ? extension : null;
}

function collectConversationDownloadRefs(
  references: ConversationFileReference[]
): Array<{ fileId: string; logicalName: string }> {
  const refsById = new Map<string, { fileId: string; logicalName: string }>();

  for (const reference of references) {
    if (!refsById.has(reference.fileId)) {
      refsById.set(reference.fileId, {
        fileId: reference.fileId,
        logicalName: reference.logicalName
      });
    }
  }

  return Array.from(refsById.values());
}

async function migrateConversationAssetFiles(
  app: App,
  targetFolderPath: string,
  sourceFolderPaths: string[],
  usedNames: Set<string>,
  logger: SyncRunLogger | null,
  logPrefix: string
): Promise<void> {
  for (const sourceFolderPath of sourceFolderPaths) {
    const sourceFolder = app.vault.getAbstractFileByPath(sourceFolderPath);
    if (!(sourceFolder instanceof TFolder)) {
      continue;
    }

    for (const child of Array.from(sourceFolder.children)) {
      if (!(child instanceof TFile)) {
        continue;
      }

      const oldPath = child.path;
      const destinationFileName = nextAvailableFileName(child.name, usedNames);
      const destinationPath = normalizePath(`${targetFolderPath}/${destinationFileName}`);
      await app.fileManager.renameFile(child, destinationPath);
      logger?.info(`${logPrefix} Migrated existing asset: ${oldPath} -> ${destinationPath}`);
    }
  }
}

export async function syncConversationAssetsForConversation(
  host: MainAssetSyncHost,
  params: SyncConversationAssetsParams
): Promise<ConversationAssetLinkMap> {
  const {
    requestConfig,
    conversation,
    baseFolder,
    conversationPathTemplate,
    assetStorageMode,
    logger,
    accountLabel,
    conversationIndex,
    totalConversations
  } = params;
  const linkMap: ConversationAssetLinkMap = {};
  const downloadRefs = collectConversationDownloadRefs(conversation.fileReferences);

  if (downloadRefs.length === 0) {
    return linkMap;
  }

  const folderPaths = resolveAssetFolderPaths({
    mode: assetStorageMode,
    baseFolder,
    conversationPathTemplate,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt
    },
    account: {
      accountId: requestConfig.accountId,
      email: requestConfig.userEmail
    }
  });
  const assetFolderPath = folderPaths.targetFolderPath;
  const logPrefix = `[${accountLabel}] (${conversationIndex}/${totalConversations})`;

  logger?.info(`${logPrefix} Resolving ${downloadRefs.length} asset reference(s) for "${conversation.title}".`);
  logger?.info(`${logPrefix} Asset storage mode: ${formatAssetStorageMode(assetStorageMode)}`);
  logger?.info(`${logPrefix} Asset folder: ${assetFolderPath}`);

  await host.ensureFolderExists(assetFolderPath);
  const usedNames = readFolderFileNames(host.app, assetFolderPath);
  const sourceFolderPaths = folderPaths.candidateFolderPaths.filter((path) => path !== assetFolderPath);
  await migrateConversationAssetFiles(host.app, assetFolderPath, sourceFolderPaths, usedNames, logger, logPrefix);

  for (const [assetIndex, ref] of downloadRefs.entries()) {
    const perAssetPrefix = `${logPrefix} Asset ${assetIndex + 1}/${downloadRefs.length} (${ref.fileId})`;

    try {
      logger?.info(`${perAssetPrefix} Resolving download metadata.`);
      const info = await fetchConversationFileDownloadInfo(requestConfig, ref.fileId);
      logger?.info(`${perAssetPrefix} Metadata resolved (file_name=${info.fileName || "<empty>"}).`);
      const rawName = sanitizePathPart(info.fileName || ref.logicalName);
      const withExtension = appendExtensionIfMissing(rawName, null);
      let preferredFileName = withExtension || sanitizePathPart(ref.logicalName);
      if (!preferredFileName.includes(".")) {
        const logicalExtension = extractKnownExtension(ref.logicalName);
        if (logicalExtension) {
          preferredFileName = `${preferredFileName}${logicalExtension}`;
        }
      }
      const preferredPath = normalizePath(`${assetFolderPath}/${preferredFileName}`);
      const preferredExisting = host.app.vault.getAbstractFileByPath(preferredPath);

      if (preferredExisting instanceof TFile) {
        linkMap[ref.fileId] = {
          path: preferredExisting.path,
          fileName: preferredExisting.name
        };
        usedNames.add(preferredExisting.name);
        logger?.info(`${perAssetPrefix} Reusing existing file: ${preferredExisting.path}`);
        continue;
      }

      if (preferredFileName !== rawName) {
        const legacyPath = normalizePath(`${assetFolderPath}/${rawName}`);
        const legacyExisting = host.app.vault.getAbstractFileByPath(legacyPath);
        if (legacyExisting instanceof TFile) {
          const migratedFileName = nextAvailableFileName(preferredFileName, usedNames);
          const migratedPath = normalizePath(`${assetFolderPath}/${migratedFileName}`);
          await host.app.vault.rename(legacyExisting, migratedPath);
          linkMap[ref.fileId] = {
            path: migratedPath,
            fileName: migratedFileName
          };
          logger?.info(`${perAssetPrefix} Renamed legacy asset: ${legacyPath} -> ${migratedPath}`);
          continue;
        }
      }

      logger?.info(`${perAssetPrefix} Downloading signed asset URL.`);
      const fileContent = await fetchSignedFileContent(requestConfig, info.downloadUrl);
      const fileNameWithType = appendExtensionIfMissing(preferredFileName, fileContent.contentType);
      const finalFileName = nextAvailableFileName(fileNameWithType, usedNames);
      const finalPath = normalizePath(`${assetFolderPath}/${finalFileName}`);
      const existingAtFinalPath = host.app.vault.getAbstractFileByPath(finalPath);

      if (existingAtFinalPath instanceof TFile) {
        linkMap[ref.fileId] = {
          path: existingAtFinalPath.path,
          fileName: existingAtFinalPath.name
        };
        logger?.info(`${perAssetPrefix} Reusing existing file: ${existingAtFinalPath.path}`);
        continue;
      }

      const created = await host.app.vault.createBinary(finalPath, fileContent.data);
      linkMap[ref.fileId] = {
        path: created.path,
        fileName: created.name
      };
      logger?.info(`${perAssetPrefix} Saved asset: ${created.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn(`${perAssetPrefix} Failed to download asset: ${message}`);
    }
  }

  return linkMap;
}
