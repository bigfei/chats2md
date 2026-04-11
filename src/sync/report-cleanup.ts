import { resolveSyncReportFolder } from "../main/helpers";

export interface SyncReportCleanupResult {
  removedPaths: string[];
  keptPaths: string[];
  reportFolder: string;
}

interface FileLike {
  path: string;
  name: string;
}

interface FolderLike {
  path: string;
  children: unknown[];
}

function isFileLike(value: unknown): value is FileLike {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as FileLike).path === "string" &&
    typeof (value as FileLike).name === "string",
  );
}

function isFolderLike(value: unknown): value is FolderLike {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as FolderLike).path === "string" &&
    Array.isArray((value as FolderLike).children),
  );
}

export async function cleanupSyncReportFiles(
  app: {
    vault: {
      getAbstractFileByPath(path: string): unknown;
    };
    fileManager: {
      trashFile(file: FileLike): Promise<void>;
    };
  },
  syncFolder: string,
  configuredReportFolder: string,
  options: {
    keepLatest?: number;
  } = {},
): Promise<SyncReportCleanupResult> {
  const reportFolder = resolveSyncReportFolder(syncFolder, configuredReportFolder);
  const reportFolderEntry = app.vault.getAbstractFileByPath(reportFolder);

  if (!isFolderLike(reportFolderEntry)) {
    return {
      removedPaths: [],
      keptPaths: [],
      reportFolder,
    };
  }

  const generatedFiles = reportFolderEntry.children
    .filter(isFileLike)
    .filter((file) => /^sync-.*\.(?:md|log)$/i.test(file.name))
    .sort((left, right) => right.name.localeCompare(left.name));

  const keepLatest = Number.isFinite(options.keepLatest) ? Math.max(0, Math.trunc(options.keepLatest ?? 0)) : 0;
  const keptFiles = generatedFiles.slice(0, keepLatest);
  const removedFiles = generatedFiles.slice(keepLatest);

  for (const file of removedFiles) {
    await app.fileManager.trashFile(file);
  }

  return {
    removedPaths: removedFiles.map((file) => file.path),
    keptPaths: keptFiles.map((file) => file.path),
    reportFolder,
  };
}
