import { ASSET_FOLDER_NAME, normalizeTargetFolder } from "./helpers";
import type { AssetStorageMode } from "../shared/types";

interface FolderCleanupHost {
  vault: {
    getAbstractFileByPath(path: string): unknown;
  };
  fileManager: {
    trashFile(file: unknown): Promise<void>;
  };
}

interface FolderCleanupPlan {
  startFolderPath: string;
  stopBeforePath: string;
}

interface FolderLike {
  path: string;
  children: unknown[];
}

export function getParentFolderPath(path: string): string {
  const normalized = normalizeTargetFolder(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

export function findSharedFolderPath(leftPath: string, rightPath: string): string {
  const leftParts = normalizeTargetFolder(leftPath).split("/").filter(Boolean);
  const rightParts = normalizeTargetFolder(rightPath).split("/").filter(Boolean);
  const shared: string[] = [];
  const total = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < total; index += 1) {
    const left = leftParts[index];
    const right = rightParts[index];

    if (!left || !right || left !== right) {
      break;
    }

    shared.push(left);
  }

  return shared.join("/");
}

export function listFolderCleanupPaths(startFolderPath: string, stopBeforePath = ""): string[] {
  const normalizedStopBefore = normalizeTargetFolder(stopBeforePath);
  const paths: string[] = [];
  let current = normalizeTargetFolder(startFolderPath);

  while (current && current !== normalizedStopBefore) {
    paths.push(current);
    current = getParentFolderPath(current);
  }

  return paths;
}

function isFolderLike(value: unknown): value is FolderLike {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<FolderLike>;
  return typeof record.path === "string" && Array.isArray(record.children);
}

export async function cleanupEmptyFolders(
  host: FolderCleanupHost,
  startFolderPath: string,
  stopBeforePath = "",
): Promise<string[]> {
  const removed: string[] = [];

  for (const folderPath of listFolderCleanupPaths(startFolderPath, stopBeforePath)) {
    const folder = host.vault.getAbstractFileByPath(folderPath);

    if (!isFolderLike(folder)) {
      break;
    }

    if (folder.children.length > 0) {
      break;
    }

    await host.fileManager.trashFile(folder);
    removed.push(folderPath);
  }

  return removed;
}

export function buildMovedConversationFolderCleanupPlans(
  previousNotePath: string,
  nextNotePath: string,
  assetStorageMode: AssetStorageMode,
): FolderCleanupPlan[] {
  const previousNoteFolder = getParentFolderPath(previousNotePath);
  const nextNoteFolder = getParentFolderPath(nextNotePath);
  const plans: FolderCleanupPlan[] = [];
  const previousAssetFolder = normalizeTargetFolder(`${previousNoteFolder}/${ASSET_FOLDER_NAME}`);

  if (assetStorageMode === "with_conversation") {
    if (previousAssetFolder) {
      plans.push({
        startFolderPath: previousAssetFolder,
        stopBeforePath: previousNoteFolder,
      });
    }
  } else {
    const assetStopBeforePath = findSharedFolderPath(previousAssetFolder, nextNoteFolder);

    if (previousAssetFolder && previousAssetFolder !== assetStopBeforePath) {
      plans.push({
        startFolderPath: previousAssetFolder,
        stopBeforePath: assetStopBeforePath,
      });
    }
  }

  const noteStopBeforePath = findSharedFolderPath(previousNoteFolder, nextNoteFolder);
  if (previousNoteFolder && previousNoteFolder !== noteStopBeforePath) {
    plans.push({
      startFolderPath: previousNoteFolder,
      stopBeforePath: noteStopBeforePath,
    });
  }

  const seen = new Set<string>();
  return plans.filter((plan) => {
    const key = `${plan.startFolderPath}::${plan.stopBeforePath}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function cleanupMovedConversationFolders(
  host: FolderCleanupHost,
  previousNotePath: string,
  nextNotePath: string,
  assetStorageMode: AssetStorageMode,
): Promise<string[]> {
  const removed = new Set<string>();

  for (const plan of buildMovedConversationFolderCleanupPlans(previousNotePath, nextNotePath, assetStorageMode)) {
    const deleted = await cleanupEmptyFolders(host, plan.startFolderPath, plan.stopBeforePath);
    deleted.forEach((path) => removed.add(path));
  }

  return Array.from(removed);
}

export async function cleanupMigratedAssetSourceFolders(
  host: FolderCleanupHost,
  sourceFolderPaths: string[],
  targetFolderPath: string,
): Promise<string[]> {
  const removed = new Set<string>();

  for (const sourceFolderPath of sourceFolderPaths) {
    const stopBeforePath = findSharedFolderPath(sourceFolderPath, targetFolderPath);
    const deleted = await cleanupEmptyFolders(host, sourceFolderPath, stopBeforePath);
    deleted.forEach((path) => removed.add(path));
  }

  return Array.from(removed);
}
