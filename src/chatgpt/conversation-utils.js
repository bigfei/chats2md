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

export function createConversationFootnoteRegistry() {
  return {
    nextId: 1,
    keyToId: new Map(),
    definitionsById: new Map(),
  };
}

function ensureFootnoteIdAndDefinition(registry, label, url) {
  const dedupKey = `${label}\u0000${url}`;
  const existingId = registry.keyToId.get(dedupKey);

  if (typeof existingId === "number") {
    return existingId;
  }

  const id = registry.nextId;
  registry.nextId += 1;
  registry.keyToId.set(dedupKey, id);
  registry.definitionsById.set(id, formatObsidianFootnoteDefinition(id, label, url));

  return id;
}

function isValidFootnoteRegistry(value) {
  return (
    isRecord(value) &&
    typeof value.nextId === "number" &&
    value.keyToId instanceof Map &&
    value.definitionsById instanceof Map
  );
}

export function getConversationFootnoteDefinitions(registry) {
  if (!isValidFootnoteRegistry(registry)) {
    return [];
  }

  return Array.from(registry.definitionsById.entries())
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]);
}

export function applyChatGptContentReferencesAsFootnotes(text, contentReferences, registry) {
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
    const footnoteId = ensureFootnoteIdAndDefinition(ensuredRegistry, label, url);
    const replacement = `[^${footnoteId}]`;
    const replaced = replaceFirstOccurrence(transformedText, matchedText, replacement);

    transformedText = replaced.text;
    if (!replaced.replaced) {
      continue;
    }
  }

  return {
    text: transformedText,
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
