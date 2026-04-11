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
  return value.replace(/[[\]]/g, "\\$&");
}

const INVALID_FILE_NAME_CHARACTER_PATTERN = new RegExp(
  `[\\\\/:*?"<>|${String.fromCharCode(0)}-${String.fromCharCode(31)}]+`,
  "g",
);

function replaceInvalidFileNameCharacters(value, replacement) {
  return value.replace(INVALID_FILE_NAME_CHARACTER_PATTERN, replacement);
}

const INVALID_CONVERSATION_TITLE_CHARS = new RegExp(
  `[\\\\/:*?"<>|${String.fromCharCode(0)}-${String.fromCharCode(31)}]+`,
  "g",
);

function readMarkdownLinkFromAlt(reference) {
  const alt = readNonEmptyString(reference?.alt);
  if (!alt) {
    return null;
  }

  const markdownLinkMatch = alt.match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (!markdownLinkMatch) {
    return null;
  }

  const [, label, url] = markdownLinkMatch;
  return {
    label: readNonEmptyString(label),
    url: readNonEmptyString(url),
  };
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

  appendUrl(reference?.url);

  const sources = Array.isArray(reference.sources) ? reference.sources : [];
  for (const source of sources) {
    const sourceRecord = isRecord(source) ? source : null;
    appendUrl(sourceRecord?.url);
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

  appendUrl(reference?.thumbnail_url);

  if (Array.isArray(reference.safe_urls)) {
    for (const safeUrl of reference.safe_urls) {
      appendUrl(safeUrl);
    }
  }

  return urls;
}

function readPrimaryContentReferenceUrl(reference) {
  const urls = collectContentReferenceUrls(reference);
  return urls[0] ?? "";
}

function readContentReferenceMatchedItemTitle(reference) {
  const markdownLink = readMarkdownLinkFromAlt(reference);
  if (!markdownLink?.url) {
    return "";
  }

  const items = Array.isArray(reference.items) ? reference.items : [];
  for (const item of items) {
    const record = isRecord(item) ? item : null;
    if (readNonEmptyString(record?.url) !== markdownLink.url) {
      continue;
    }

    const title = readNonEmptyString(record?.title);
    if (title) {
      return title;
    }
  }

  return "";
}

function readContentReferenceLabelFromAlt(reference) {
  const alt = readNonEmptyString(reference.alt);
  if (!alt) {
    return "";
  }

  const markdownLink = readMarkdownLinkFromAlt(reference);
  if (markdownLink?.label) {
    return markdownLink.label;
  }

  return alt.replace(/^\(+|\)+$/g, "").trim();
}

function readContentReferenceLabel(reference, fallbackIndex) {
  const matchedItemTitle = readContentReferenceMatchedItemTitle(reference);
  if (matchedItemTitle) {
    return matchedItemTitle;
  }

  const altLabel = readContentReferenceLabelFromAlt(reference);
  if (altLabel) {
    return altLabel;
  }

  const items = Array.isArray(reference.items) ? reference.items : [];
  const firstItem = isRecord(items[0]) ? items[0] : null;
  const label =
    readNonEmptyString(firstItem?.attribution) ||
    readNonEmptyString(firstItem?.title) ||
    readNonEmptyString(reference.type);
  return label || `Source ${fallbackIndex}`;
}

function readContentReferencePlainText(reference, fallbackIndex) {
  const label =
    readNonEmptyString(reference.alt) ||
    readNonEmptyString(reference.name) ||
    readNonEmptyString(reference.prompt_text) ||
    readNonEmptyString(reference.title) ||
    readContentReferenceLabel(reference, fallbackIndex);

  return label || "";
}

function shouldRenderReferenceAsUnderlinedPlainText(reference) {
  const type = readNonEmptyString(reference?.type);
  return type === "entity";
}

function shouldRenderReferenceAsEmbeddedMedia(reference) {
  const type = readNonEmptyString(reference?.type);
  return type === "video";
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
    return {
      text,
      replaced: false,
    };
  }

  return {
    text: `${text.slice(0, index)}${replacement}${text.slice(index + matchedText.length)}`,
    replaced: true,
  };
}

function formatObsidianFootnoteDefinition(id, label, url) {
  return `[^${id}]: [${escapeMarkdownLinkLabel(label)}](${url})`;
}

function formatConversationFootnotePlaceholder(id) {
  return `[^__chats2md-footnote-${id}__]`;
}

const CONVERSATION_FOOTNOTE_PLACEHOLDER_PATTERN = /\[\^__chats2md-footnote-(\d+)__\]/g;

export function createConversationFootnoteRegistry() {
  return {
    nextBaseId: 1,
    nextOccurrenceId: 1,
    baseIdByUrl: new Map(),
    occurrenceIdsByUrl: new Map(),
    occurrencesById: new Map(),
  };
}

function registerFootnoteOccurrence(registry, label, url) {
  let baseId = registry.baseIdByUrl.get(url);
  if (typeof baseId !== "number") {
    baseId = registry.nextBaseId;
    registry.nextBaseId += 1;
    registry.baseIdByUrl.set(url, baseId);
  }

  const occurrenceIds = registry.occurrenceIdsByUrl.get(url) ?? [];
  const id = registry.nextOccurrenceId;
  registry.nextOccurrenceId += 1;
  occurrenceIds.push(id);
  registry.occurrenceIdsByUrl.set(url, occurrenceIds);
  registry.occurrencesById.set(id, {
    id,
    baseId,
    occurrenceIndex: occurrenceIds.length,
    label,
    url,
  });

  return id;
}

function readConversationFootnoteDisplayId(registry, id) {
  const occurrence = registry.occurrencesById.get(id);
  if (!occurrence) {
    return "";
  }

  const occurrenceIds = registry.occurrenceIdsByUrl.get(occurrence.url) ?? [];
  if (occurrenceIds.length <= 1) {
    return String(occurrence.baseId);
  }

  return `${occurrence.baseId}-${occurrence.occurrenceIndex}`;
}

function isValidFootnoteRegistry(value) {
  return (
    isRecord(value) &&
    typeof value.nextBaseId === "number" &&
    typeof value.nextOccurrenceId === "number" &&
    value.baseIdByUrl instanceof Map &&
    value.occurrenceIdsByUrl instanceof Map &&
    value.occurrencesById instanceof Map
  );
}

export function getConversationFootnoteDefinitions(registry) {
  if (!isValidFootnoteRegistry(registry)) {
    return [];
  }

  return Array.from(registry.occurrencesById.values())
    .sort((left, right) => left.baseId - right.baseId || left.occurrenceIndex - right.occurrenceIndex)
    .map((occurrence) =>
      formatObsidianFootnoteDefinition(
        readConversationFootnoteDisplayId(registry, occurrence.id),
        occurrence.label,
        occurrence.url,
      ),
    );
}

export function finalizeConversationFootnoteText(text, registry) {
  const sourceText = String(text ?? "");

  if (!isValidFootnoteRegistry(registry)) {
    return sourceText;
  }

  return sourceText.replace(CONVERSATION_FOOTNOTE_PLACEHOLDER_PATTERN, (match, idValue) => {
    const displayId = readConversationFootnoteDisplayId(registry, Number(idValue));
    return displayId ? `[^${displayId}]` : match;
  });
}

export function applyChatGptContentReferencesAsFootnotes(text, contentReferences, registry, options = {}) {
  const sourceText = String(text ?? "");
  const sortedReferences = sortContentReferencesByStartIndex(Array.isArray(contentReferences) ? contentReferences : []);

  if (sortedReferences.length === 0) {
    return {
      text: sourceText,
      footnotes: [],
    };
  }

  let transformedText = sourceText;
  const ensuredRegistry = isValidFootnoteRegistry(registry) ? registry : createConversationFootnoteRegistry();
  const shouldFinalizeText = options.finalizeText !== false;

  for (const [referenceIndex, reference] of sortedReferences.entries()) {
    const matchedText = readNonEmptyString(reference.matched_text);
    if (!matchedText || matchedText.trim().length === 0) {
      continue;
    }

    const url = readPrimaryContentReferenceUrl(reference);
    if (!transformedText.includes(matchedText)) {
      continue;
    }

    if (!url) {
      const plainText = readContentReferencePlainText(reference, referenceIndex + 1);
      const replacement = shouldRenderReferenceAsUnderlinedPlainText(reference) ? `<u>${plainText}</u>` : plainText;
      transformedText = replaceFirstOccurrence(transformedText, matchedText, replacement).text;
      continue;
    }

    const label = readContentReferenceLabel(reference, referenceIndex + 1);
    if (shouldRenderReferenceAsEmbeddedMedia(reference)) {
      const replacement = `${label}\n![](${url})`;
      transformedText = replaceFirstOccurrence(transformedText, matchedText, replacement).text;
      continue;
    }
    const footnoteId = registerFootnoteOccurrence(ensuredRegistry, label, url);
    const replacement = formatConversationFootnotePlaceholder(footnoteId);
    const replaced = replaceFirstOccurrence(transformedText, matchedText, replacement);

    transformedText = replaced.text;
    if (!replaced.replaced) {
      continue;
    }
  }

  return {
    text: shouldFinalizeText ? finalizeConversationFootnoteText(transformedText, ensuredRegistry) : transformedText,
    footnotes: getConversationFootnoteDefinitions(ensuredRegistry),
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
  const normalized = String(title ?? "")
    .normalize("NFKC")
    .trim();

  if (!normalized) {
    return "untitled-conversation";
  }

  const sanitized = normalized.replace(INVALID_CONVERSATION_TITLE_CHARS, "-");

  const fileNameSafe = replaceInvalidFileNameCharacters(sanitized, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return fileNameSafe || "untitled-conversation";
}

export function extractConversationListPageInfo(payload, fallbackLimit = 100) {
  const normalizedFallbackLimit = Math.max(1, Math.trunc(toNumber(fallbackLimit) ?? 100));

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      limit: normalizedFallbackLimit,
      offset: 0,
      total: null,
    };
  }

  const limit = toNonNegativeInteger(payload.limit);
  const offset = toNonNegativeInteger(payload.offset);
  const total = toNonNegativeInteger(payload.total);

  return {
    limit: Math.max(1, limit ?? normalizedFallbackLimit),
    offset: offset ?? 0,
    total,
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
