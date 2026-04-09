import { appendExtensionIfMissing, sanitizePathPart } from "./helpers";

export interface LocalAssetReference {
  fileId: string;
  logicalName: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractKnownExtension(fileName: string): string {
  const trimmed = fileName.trim();
  const dotIndex = trimmed.lastIndexOf(".");

  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) {
    return "";
  }

  const extension = trimmed.slice(dotIndex).toLowerCase();
  return /^[.][a-z0-9]{1,12}$/i.test(extension) ? extension : "";
}

function getStem(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

function hasFileName(fileNames: Iterable<string>, candidate: string): boolean {
  if (fileNames instanceof Set) {
    return fileNames.has(candidate);
  }

  for (const fileName of fileNames) {
    if (fileName === candidate) {
      return true;
    }
  }

  return false;
}

function findUniqueStemMatch(fileNames: Iterable<string>, stem: string): string | null {
  let match: string | null = null;

  for (const fileName of fileNames) {
    if (getStem(fileName) !== stem) {
      continue;
    }

    if (match !== null) {
      return null;
    }

    match = fileName;
  }

  return match;
}

export function buildStableAssetFileName(
  fileId: string,
  preferredName: string,
  logicalName: string,
  contentType: string | null = null,
): string {
  const normalizedFileId = sanitizePathPart(fileId) || "file";
  const seededName = sanitizePathPart(preferredName) || sanitizePathPart(logicalName) || normalizedFileId;
  const withType = appendExtensionIfMissing(seededName, contentType);
  const extension = extractKnownExtension(withType) || extractKnownExtension(logicalName);

  return extension ? `${normalizedFileId}${extension}` : normalizedFileId;
}

export function findReusableLocalAssetFileName(fileNames: Iterable<string>, ref: LocalAssetReference): string | null {
  const normalizedFileId = sanitizePathPart(ref.fileId);
  const logicalExtension = extractKnownExtension(ref.logicalName);
  const preferredExactMatch = logicalExtension ? `${normalizedFileId}${logicalExtension}` : normalizedFileId;

  if (hasFileName(fileNames, preferredExactMatch)) {
    return preferredExactMatch;
  }

  if (preferredExactMatch !== normalizedFileId && hasFileName(fileNames, normalizedFileId)) {
    return normalizedFileId;
  }

  return findUniqueStemMatch(fileNames, normalizedFileId);
}

export function findMigratableLegacyAssetFileName(fileNames: string[], ref: LocalAssetReference): string | null {
  const normalizedLogicalName = sanitizePathPart(ref.logicalName);

  if (!normalizedLogicalName) {
    return null;
  }

  const dotIndex = normalizedLogicalName.lastIndexOf(".");
  const stem = dotIndex > 0 ? normalizedLogicalName.slice(0, dotIndex) : normalizedLogicalName;
  const extension = dotIndex > 0 ? normalizedLogicalName.slice(dotIndex) : "";
  const siblingPattern = new RegExp(`^${escapeRegExp(stem)}_\\d+${escapeRegExp(extension)}$`);
  const relatedMatches = fileNames.filter(
    (fileName) => fileName === normalizedLogicalName || siblingPattern.test(fileName),
  );

  return relatedMatches.length === 1 ? (relatedMatches[0] ?? null) : null;
}
