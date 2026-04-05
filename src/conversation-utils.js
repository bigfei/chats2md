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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function escapeMarkdownLinkLabel(value) {
  return value.replace(/[\[\]]/g, "\\$&");
}

function collectContentReferenceUrls(reference) {
  const urls = [];
  const appendUrl = (value) => {
    const url = readNonEmptyString(value);
    if (!url || urls.includes(url)) {
      return;
    }
    urls.push(url);
  };

  if (Array.isArray(reference.safe_urls)) {
    for (const safeUrl of reference.safe_urls) {
      appendUrl(safeUrl);
    }
  }

  const items = Array.isArray(reference.items) ? reference.items : [];
  for (const item of items) {
    const record = isRecord(item) ? item : null;
    appendUrl(record?.url);

    const supportingWebsites = Array.isArray(record?.supporting_websites) ? record.supporting_websites : [];
    for (const supportingWebsite of supportingWebsites) {
      const supportingRecord = isRecord(supportingWebsite) ? supportingWebsite : null;
      appendUrl(supportingRecord?.url);
    }
  }

  return urls;
}

function readPrimaryContentReferenceUrl(reference) {
  const urls = collectContentReferenceUrls(reference);
  return urls[0] ?? "";
}

function readContentReferenceLabelFromAlt(reference) {
  const alt = readNonEmptyString(reference.alt);
  if (!alt) {
    return "";
  }

  const markdownLinkMatch = alt.match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (markdownLinkMatch?.[1]) {
    return markdownLinkMatch[1].trim();
  }

  return alt
    .replace(/^\(+|\)+$/g, "")
    .trim();
}

function readContentReferenceLabel(reference, fallbackIndex) {
  const altLabel = readContentReferenceLabelFromAlt(reference);
  if (altLabel) {
    return altLabel;
  }

  const items = Array.isArray(reference.items) ? reference.items : [];
  const firstItem = isRecord(items[0]) ? items[0] : null;
  const label = readNonEmptyString(firstItem?.attribution)
    || readNonEmptyString(firstItem?.title)
    || readNonEmptyString(reference.type);
  return label || `Source ${fallbackIndex}`;
}

function sortContentReferencesByStartIndex(contentReferences) {
  const normalized = contentReferences.filter(isRecord);
  return normalized.sort((left, right) => {
    const leftStart = toNonNegativeInteger(left.start_idx) ?? Number.MAX_SAFE_INTEGER;
    const rightStart = toNonNegativeInteger(right.start_idx) ?? Number.MAX_SAFE_INTEGER;
    return leftStart - rightStart;
  });
}

function replaceFirstOccurrence(text, matchedText, replacement) {
  const index = text.indexOf(matchedText);
  if (index === -1) {
    return text;
  }

  return `${text.slice(0, index)}${replacement}${text.slice(index + matchedText.length)}`;
}

function buildReferenceId(reference, fallbackIndex, usedIds) {
  const startIndex = toNonNegativeInteger(reference.start_idx);
  const endIndex = toNonNegativeInteger(reference.end_idx);
  const baseId = startIndex !== null && endIndex !== null
    ? `ref-${startIndex}-${endIndex}`
    : `ref-${fallbackIndex}`;

  let candidate = baseId;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

export function applyChatGptContentReferencesAsReferenceLinks(text, contentReferences) {
  const sourceText = String(text ?? "");
  const sortedReferences = sortContentReferencesByStartIndex(Array.isArray(contentReferences) ? contentReferences : []);

  if (sortedReferences.length === 0) {
    return {
      text: sourceText,
      references: []
    };
  }

  let transformedText = sourceText;
  const usedReferenceIds = new Set();
  const referenceDefinitions = [];

  for (const [referenceIndex, reference] of sortedReferences.entries()) {
    const matchedText = readNonEmptyString(reference.matched_text);
    if (!matchedText || matchedText.trim().length === 0) {
      continue;
    }

    const url = readPrimaryContentReferenceUrl(reference);
    if (!url) {
      transformedText = replaceFirstOccurrence(transformedText, matchedText, "");
      continue;
    }

    const referenceId = buildReferenceId(reference, referenceIndex + 1, usedReferenceIds);
    const label = readContentReferenceLabel(reference, referenceIndex + 1);
    const replacement = `[${escapeMarkdownLinkLabel(label)}][${referenceId}]`;
    referenceDefinitions.push(`[${referenceId}]: ${url}`);

    transformedText = replaceFirstOccurrence(
      transformedText,
      matchedText,
      replacement
    );
  }

  return {
    text: transformedText,
    references: referenceDefinitions
  };
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
