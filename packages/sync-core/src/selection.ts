const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ItemDateSpan {
  minValue: string;
  maxValue: string;
  spanMs: number;
  validCount: number;
}

function parseTimestamp(value: string): number | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIsoDateAtUtc(date: string, time: string): number | null {
  if (!ISO_DATE_PATTERN.test(date)) {
    return null;
  }

  const parsed = Date.parse(`${date}T${time}Z`);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString().slice(0, 10) === date ? parsed : null;
}

function parseIsoDateStart(date: string): number | null {
  return parseIsoDateAtUtc(date, "00:00:00.000");
}

function parseIsoDateEnd(date: string): number | null {
  return parseIsoDateAtUtc(date, "23:59:59.999");
}

export function toIsoUtcDate(value: string): string | null {
  const parsed = parseTimestamp(value);
  if (parsed === null) {
    return null;
  }

  return new Date(parsed).toISOString().slice(0, 10);
}

export function sortItemsByDateDesc<T>(items: T[], getValue: (item: T) => string): T[] {
  return items
    .map((item, index) => ({
      item,
      index,
      timestamp: parseTimestamp(getValue(item)),
    }))
    .sort((left, right) => {
      const leftRank = left.timestamp ?? Number.NEGATIVE_INFINITY;
      const rightRank = right.timestamp ?? Number.NEGATIVE_INFINITY;

      if (leftRank !== rightRank) {
        return rightRank - leftRank;
      }

      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

export function getItemDateSpan<T>(items: T[], getValue: (item: T) => string): ItemDateSpan | null {
  let minTimestamp = Number.POSITIVE_INFINITY;
  let maxTimestamp = Number.NEGATIVE_INFINITY;
  let minValue = "";
  let maxValue = "";
  let validCount = 0;

  for (const item of items) {
    const value = getValue(item);
    const timestamp = parseTimestamp(value);
    if (timestamp === null) {
      continue;
    }

    validCount += 1;

    if (timestamp < minTimestamp) {
      minTimestamp = timestamp;
      minValue = value;
    }

    if (timestamp > maxTimestamp) {
      maxTimestamp = timestamp;
      maxValue = value;
    }
  }

  if (validCount === 0) {
    return null;
  }

  return {
    minValue,
    maxValue,
    spanMs: Math.max(0, maxTimestamp - minTimestamp),
    validCount,
  };
}

export function filterItemsByDateRange<T>(
  items: T[],
  startDate: string,
  endDate: string,
  getValue: (item: T) => string,
): T[] {
  const startTimestamp = parseIsoDateStart(startDate);
  const endTimestamp = parseIsoDateEnd(endDate);

  if (startTimestamp === null || endTimestamp === null) {
    throw new Error("Date range must use YYYY-MM-DD format.");
  }

  if (startTimestamp > endTimestamp) {
    throw new Error("Date range start date must be before or equal to end date.");
  }

  return items.filter((item) => {
    const timestamp = parseTimestamp(getValue(item));
    return timestamp !== null && timestamp >= startTimestamp && timestamp <= endTimestamp;
  });
}

export function limitItems<T>(items: T[], count: number, sortItems?: (items: T[]) => T[]): T[] {
  if (!Number.isFinite(count)) {
    throw new Error("Item limit must be a positive integer.");
  }

  const normalizedCount = Math.trunc(count);
  if (normalizedCount < 1) {
    throw new Error("Item limit must be a positive integer.");
  }

  return (sortItems ? sortItems(items) : [...items]).slice(0, normalizedCount);
}
