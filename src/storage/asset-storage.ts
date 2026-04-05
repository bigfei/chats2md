import { ASSET_FOLDER_NAME, normalizeTargetFolder, sanitizePathPart } from "../main/helpers";
import { normalizeObsidianPath } from "../path/normalization";
import { resolveConversationNoteRelativePath } from "../path/template";
import type { AssetStorageMode } from "../shared/types";

export interface AssetFolderPathContext {
  mode: AssetStorageMode;
  baseFolder: string;
  conversationPathTemplate: string;
  conversation: {
    id: string;
    title: string;
    updatedAt: string;
  };
  account: {
    accountId: string;
    email: string;
  };
}

export interface ResolvedAssetFolderPaths {
  targetFolderPath: string;
  globalFolderPath: string;
  localFolderPath: string;
  candidateFolderPaths: string[];
}

function getFolderPath(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? "" : filePath.slice(0, index);
}

export function resolveAssetFolderPaths(context: AssetFolderPathContext): ResolvedAssetFolderPaths {
  const normalizedBaseFolder = normalizeTargetFolder(context.baseFolder);

  if (!normalizedBaseFolder) {
    throw new Error("A vault folder is required.");
  }

  const conversationFolder = sanitizePathPart(context.conversation.id);
  const accountFolder = sanitizePathPart(context.account.accountId || "account");
  const globalFolderPath = normalizeObsidianPath(`${normalizedBaseFolder}/${ASSET_FOLDER_NAME}/${accountFolder}`);
  const noteRelativePath = resolveConversationNoteRelativePath(context.conversationPathTemplate, {
    title: context.conversation.title,
    updatedAt: context.conversation.updatedAt,
    conversationId: context.conversation.id,
    email: context.account.email,
    accountId: context.account.accountId,
  });
  const noteRelativeFolder = getFolderPath(noteRelativePath);
  const noteFolderPath =
    noteRelativeFolder.length > 0
      ? normalizeObsidianPath(`${normalizedBaseFolder}/${noteRelativeFolder}`)
      : normalizedBaseFolder;
  const localFolderPath = normalizeObsidianPath(`${noteFolderPath}/${ASSET_FOLDER_NAME}`);
  const legacyGlobalFolderPath = normalizeObsidianPath(`${globalFolderPath}/${conversationFolder}`);
  const legacyLocalFolderPath = normalizeObsidianPath(`${localFolderPath}/${conversationFolder}`);
  const targetFolderPath = context.mode === "with_conversation" ? localFolderPath : globalFolderPath;
  const candidateFolderPaths = Array.from(new Set([legacyGlobalFolderPath, legacyLocalFolderPath]));

  return {
    targetFolderPath,
    globalFolderPath,
    localFolderPath,
    candidateFolderPaths,
  };
}
