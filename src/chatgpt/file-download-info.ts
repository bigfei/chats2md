type UnknownRecord = Record<string, unknown>;

export interface FileDownloadInfo {
  downloadUrl: string;
  fileName: string;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function toRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function buildFileDownloadMetadataError(record: UnknownRecord, fileId: string): string | null {
  if (readString(record.status).toLowerCase() !== "error") {
    return null;
  }

  const detailParts = [
    `status=${readString(record.status, "error")}`,
    readString(record.error_code) ? `error_code=${readString(record.error_code)}` : "",
    readString(record.error_type) ? `error_type=${readString(record.error_type)}` : "",
    readString(record.error_message) ? `error_message=${readString(record.error_message)}` : "",
  ].filter((part) => part.length > 0);

  return `File download metadata for ${fileId} failed: ${detailParts.join(", ")}.`;
}

export function normalizeFileDownloadInfo(payload: unknown, fileId: string): FileDownloadInfo {
  const record = toRecord(payload);

  if (!record) {
    throw new Error(`File download metadata for ${fileId} is not a JSON object.`);
  }

  const metadataError = buildFileDownloadMetadataError(record, fileId);
  if (metadataError) {
    throw new Error(metadataError);
  }

  const downloadUrl = readString(record.download_url);
  if (!downloadUrl) {
    throw new Error(`File download metadata for ${fileId} is missing download_url.`);
  }

  const fileName = readString(record.file_name);
  return {
    downloadUrl,
    fileName: fileName || fileId,
  };
}
