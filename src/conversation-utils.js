function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toDate(value) {
  const numeric = toNumber(value);

  if (numeric !== null) {
    const milliseconds = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function toNonNegativeInteger(value) {
  const numeric = toNumber(value);

  if (numeric === null || !Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  return Math.trunc(numeric);
}

export function normalizeConversationTimestamp(value, fallback = "") {
  const date = toDate(value);
  return date ? date.toISOString() : fallback;
}

export function getDateBucketFromTimestamp(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : "unknown-date";
}

export function slugifyConversationTitle(title) {
  const normalized = String(title ?? "").normalize("NFKC").trim();

  if (!normalized) {
    return "untitled-conversation";
  }

  const sanitized = normalized
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return sanitized || "untitled-conversation";
}

export function extractConversationListPageInfo(payload, fallbackLimit = 100) {
  const normalizedFallbackLimit = Math.max(1, Math.trunc(toNumber(fallbackLimit) ?? 100));

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      limit: normalizedFallbackLimit,
      offset: 0,
      total: null
    };
  }

  const limit = toNonNegativeInteger(payload.limit);
  const offset = toNonNegativeInteger(payload.offset);
  const total = toNonNegativeInteger(payload.total);

  return {
    limit: Math.max(1, limit ?? normalizedFallbackLimit),
    offset: offset ?? 0,
    total
  };
}

export function shouldFetchNextConversationListPage(pageItemCount, pageInfo, fallbackLimit = 100) {
  const parsedItemCount = toNonNegativeInteger(pageItemCount);

  if (parsedItemCount === null || parsedItemCount === 0) {
    return false;
  }

  const metadata = extractConversationListPageInfo(pageInfo, fallbackLimit);
  return parsedItemCount >= metadata.limit;
}

export function getNextConversationListOffset(currentOffset, pageInfo, fallbackLimit = 100) {
  const metadata = extractConversationListPageInfo(pageInfo, fallbackLimit);
  const normalizedCurrentOffset = Math.max(0, Math.trunc(toNumber(currentOffset) ?? 0));
  const nextFromResponse = metadata.offset + metadata.limit;

  if (nextFromResponse > normalizedCurrentOffset) {
    return nextFromResponse;
  }

  return normalizedCurrentOffset + metadata.limit;
}
