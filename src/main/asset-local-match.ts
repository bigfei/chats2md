import { sanitizePathPart } from "./helpers";

export interface LocalAssetReference {
  fileId: string;
  logicalName: string;
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

function findUniqueStemMatch(fileNames: string[], stem: string): string | null {
  const matches = fileNames.filter((fileName) => getStem(fileName) === stem);
  return matches.length === 1 ? matches[0] ?? null : null;
}

export function findReusableLocalAssetFileName(fileNames: string[], ref: LocalAssetReference): string | null {
  const normalizedFileId = sanitizePathPart(ref.fileId);
  const normalizedLogicalName = sanitizePathPart(ref.logicalName);
  const logicalExtension = extractKnownExtension(ref.logicalName);
  const exactCandidates = [
    logicalExtension ? `${normalizedFileId}${logicalExtension}` : "",
    normalizedFileId,
    normalizedLogicalName,
  ].filter((candidate, index, all): candidate is string => candidate.length > 0 && all.indexOf(candidate) === index);

  for (const candidate of exactCandidates) {
    if (fileNames.includes(candidate)) {
      return candidate;
    }
  }

  const stemCandidates = Array.from(
    new Set(
      [
        normalizedFileId,
        getStem(normalizedLogicalName),
      ].filter((candidate) => candidate.length > 0),
    ),
  );

  for (const candidate of stemCandidates) {
    const match = findUniqueStemMatch(fileNames, candidate);
    if (match) {
      return match;
    }
  }

  return null;
}
