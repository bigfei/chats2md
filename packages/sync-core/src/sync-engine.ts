import { NoopCacheStore, type CacheStore } from "./cache";
import { NoopCheckpointStore, type CheckpointStore, type SyncCheckpointState } from "./checkpoint";
import { isSyncCancelledError, toSyncCancelledError } from "./cancellation";
import { filterItemsByDateRange, limitItems, sortItemsByDateDesc } from "./selection";
import { retryOperation } from "./retry";
import { createFetchTransport, type Transport } from "./transport";
import type { AuthProvider } from "./auth";

export type SyncMode = "full" | "delta" | "date-range";
export type SyncSummaryErrorAction = "retry" | "continue" | "throw" | "abort";

export interface SyncQuery<TSummary = unknown> {
  mode: SyncMode;
  dateRange?: {
    start: string;
    end: string;
  };
  itemLimit?: number | null;
  checkpoint?: {
    key: string;
    scope?: string;
  };
  seedSummaries?: TSummary[];
  list?: {
    pageLimit?: number;
    parallelism?: number;
    retryAttempts?: number;
  };
  record?: {
    retryAttempts?: number;
  };
  signal?: AbortSignal;
}

export interface SyncSourceCapabilities {
  full: boolean;
  delta?: boolean;
  dateRange?: boolean;
  fetchAsset?: boolean;
}

export interface SyncListPageRequest<TCursor, TSummary, TCheckpoint> {
  cursor: TCursor | null;
  checkpoint: TCheckpoint | null;
  query: SyncQuery<TSummary>;
  transport: Transport;
  authProvider?: AuthProvider;
  signal?: AbortSignal;
}

export interface SyncListPageResult<TCursor, TSummary, TCheckpoint> {
  items: TSummary[];
  nextCursor: TCursor | null;
  expectedTotal?: number | null;
  checkpoint?: TCheckpoint | null;
}

export interface SyncFetchRecordRequest<TSummary> {
  summary: TSummary;
  query: SyncQuery<TSummary>;
  transport: Transport;
  authProvider?: AuthProvider;
  signal?: AbortSignal;
}

export interface SyncFetchRecordResult<TRecord, TCheckpoint> {
  record: TRecord;
  raw?: unknown;
  checkpoint?: TCheckpoint | null;
}

export interface SyncSourceAdapter<TCursor, TSummary, TRecord, TCheckpoint> {
  sourceId: string;
  capabilities: SyncSourceCapabilities;
  getSummaryId(summary: TSummary): string;
  getSummaryCreatedAt?(summary: TSummary): string;
  mergeSummary?(existing: TSummary, candidate: TSummary): TSummary;
  sortSummaries?(summaries: TSummary[]): TSummary[];
  shouldRetry?(error: unknown, signal?: AbortSignal): boolean;
  getListPageCacheKey?(request: SyncListPageRequest<TCursor, TSummary, TCheckpoint>): string | null;
  listPage(
    request: SyncListPageRequest<TCursor, TSummary, TCheckpoint>,
  ): Promise<SyncListPageResult<TCursor, TSummary, TCheckpoint>>;
  getRecordCacheKey?(request: SyncFetchRecordRequest<TSummary>): string | null;
  fetchRecord(request: SyncFetchRecordRequest<TSummary>): Promise<SyncFetchRecordResult<TRecord, TCheckpoint>>;
}

export type SyncEvent<TSummary, TRecord, TCursor, TCheckpoint> =
  | {
      type: "list-page";
      cursor: TCursor | null;
      pageCount: number;
      discoveredCount: number;
      expectedTotal: number | null;
    }
  | {
      type: "list-page-retry";
      cursor: TCursor | null;
      attemptNumber: number;
      maxAttempts: number;
      message: string;
    }
  | {
      type: "discovery-complete";
      discoveredCount: number;
      selectedCount: number;
    }
  | {
      type: "summary-start";
      summary: TSummary;
      index: number;
      total: number;
    }
  | {
      type: "summary-retry";
      summary: TSummary;
      index: number;
      total: number;
      attemptNumber: number;
      maxAttempts: number;
      message: string;
    }
  | {
      type: "summary-skip";
      summary: TSummary;
      index: number;
      total: number;
      reason?: string;
    }
  | {
      type: "summary-success";
      summary: TSummary;
      record: TRecord;
      raw?: unknown;
      index: number;
      total: number;
    }
  | {
      type: "summary-failure";
      summary: TSummary;
      index: number;
      total: number;
      attempts: number;
      error: Error;
    }
  | {
      type: "cache-hit";
      stage: "list-page" | "record";
      key: string;
    }
  | {
      type: "cache-write";
      stage: "list-page" | "record";
      key: string;
    }
  | {
      type: "checkpoint-saved";
      key: string;
      state: SyncCheckpointState<TCursor, TCheckpoint>;
    };

export type SyncEventHandler<TSummary, TRecord, TCursor, TCheckpoint> = (
  event: SyncEvent<TSummary, TRecord, TCursor, TCheckpoint>,
) => void | Promise<void>;

export interface BeforeFetchSummaryResult {
  skip?: boolean;
  reason?: string;
}

export interface BeforeFetchSummaryContext<TSummary> {
  summary: TSummary;
  index: number;
  total: number;
}

export interface SummaryErrorContext<TSummary> {
  summary: TSummary;
  index: number;
  total: number;
  attempts: number;
}

export interface RecordSinkContext<TSummary, TRecord> {
  summary: TSummary;
  record: TRecord;
  raw?: unknown;
  index: number;
  total: number;
}

export interface CreateSyncEngineOptions<TCursor, TSummary, TRecord, TCheckpoint> {
  source: SyncSourceAdapter<TCursor, TSummary, TRecord, TCheckpoint>;
  transport?: Transport;
  authProvider?: AuthProvider;
  cacheStore?: CacheStore;
  checkpointStore?: CheckpointStore<TCursor, TCheckpoint>;
  onEvent?: SyncEventHandler<TSummary, TRecord, TCursor, TCheckpoint>;
  onRecord?: (context: RecordSinkContext<TSummary, TRecord>) => Promise<void>;
  beforeFetchSummary?: (context: BeforeFetchSummaryContext<TSummary>) => Promise<BeforeFetchSummaryResult | void>;
  onSummaryError?: (error: Error, context: SummaryErrorContext<TSummary>) => Promise<SyncSummaryErrorAction | void>;
  createTimestamp?: () => string;
}

export interface SyncRunResult<TSummary, TCheckpoint, TCursor> {
  discoveredSummaries: TSummary[];
  selectedSummaries: TSummary[];
  processedCount: number;
  skippedCount: number;
  failureCount: number;
  checkpointState: SyncCheckpointState<TCursor, TCheckpoint> | null;
}

function buildCheckpointKey(checkpoint: NonNullable<SyncQuery["checkpoint"]>): string {
  if (checkpoint.scope && checkpoint.scope.trim().length > 0) {
    return `${checkpoint.scope.trim()}:${checkpoint.key}`;
  }

  return checkpoint.key;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function emitEvent<TSummary, TRecord, TCursor, TCheckpoint>(
  onEvent: SyncEventHandler<TSummary, TRecord, TCursor, TCheckpoint> | undefined,
  event: SyncEvent<TSummary, TRecord, TCursor, TCheckpoint>,
): Promise<void> {
  await onEvent?.(event);
}

function validateQueryMode<TCursor, TSummary, TRecord, TCheckpoint>(
  source: SyncSourceAdapter<TCursor, TSummary, TRecord, TCheckpoint>,
  query: SyncQuery<TSummary>,
): void {
  if (query.mode === "full" && !source.capabilities.full) {
    throw new Error(`Source "${source.sourceId}" does not support full sync.`);
  }

  if (query.mode === "delta" && !source.capabilities.delta) {
    throw new Error(`Source "${source.sourceId}" does not support delta sync.`);
  }

  if (query.mode === "date-range" && !source.capabilities.dateRange) {
    throw new Error(`Source "${source.sourceId}" does not support date-range sync.`);
  }
}

function dedupeSummaries<TCursor, TSummary, TRecord, TCheckpoint>(
  source: SyncSourceAdapter<TCursor, TSummary, TRecord, TCheckpoint>,
  summaries: TSummary[],
): TSummary[] {
  const merged = new Map<string, TSummary>();
  const mergeSummary = source.mergeSummary ?? ((_existing: TSummary, candidate: TSummary) => candidate);

  for (const summary of summaries) {
    const id = source.getSummaryId(summary);
    const existing = merged.get(id);
    merged.set(id, existing ? mergeSummary(existing, summary) : summary);
  }

  return Array.from(merged.values());
}

function selectSummaries<TCursor, TSummary, TRecord, TCheckpoint>(
  source: SyncSourceAdapter<TCursor, TSummary, TRecord, TCheckpoint>,
  query: SyncQuery<TSummary>,
  summaries: TSummary[],
): TSummary[] {
  const sortForLatestLimit =
    source.sortSummaries ??
    (source.getSummaryCreatedAt
      ? (items: TSummary[]) => sortItemsByDateDesc(items, (item) => source.getSummaryCreatedAt?.(item) ?? "")
      : (items: TSummary[]) => items);

  let selected = dedupeSummaries(source, summaries);

  if (query.mode === "date-range") {
    if (!query.dateRange) {
      throw new Error("Date-range sync requires start and end dates.");
    }

    if (!source.getSummaryCreatedAt) {
      throw new Error(`Source "${source.sourceId}" does not expose summary createdAt values.`);
    }

    selected = filterItemsByDateRange(
      selected,
      query.dateRange.start,
      query.dateRange.end,
      (summary) => source.getSummaryCreatedAt?.(summary) ?? "",
    );

    if (source.sortSummaries) {
      selected = source.sortSummaries(selected);
    }
  }

  if (query.itemLimit !== null && typeof query.itemLimit !== "undefined") {
    selected = limitItems(selected, query.itemLimit, sortForLatestLimit);
  }

  return selected;
}

export function createSyncEngine<TCursor, TSummary, TRecord, TCheckpoint>(
  options: CreateSyncEngineOptions<TCursor, TSummary, TRecord, TCheckpoint>,
): {
  run(query: SyncQuery<TSummary>): Promise<SyncRunResult<TSummary, TCheckpoint, TCursor>>;
} {
  const transport = options.transport ?? createFetchTransport();
  const cacheStore = options.cacheStore ?? new NoopCacheStore();
  const checkpointStore = options.checkpointStore ?? new NoopCheckpointStore<TCursor, TCheckpoint>();
  const createTimestamp = options.createTimestamp ?? (() => new Date().toISOString());

  return {
    async run(query) {
      validateQueryMode(options.source, query);

      const checkpointKey = query.checkpoint ? buildCheckpointKey(query.checkpoint) : null;
      let checkpointState = checkpointKey ? await checkpointStore.get(checkpointKey) : null;
      let nextCursor: TCursor | null = checkpointState?.nextCursor ?? null;
      let latestCheckpoint = checkpointState?.sourceCheckpoint ?? null;

      const discoveredSummaries: TSummary[] = [];

      if (Array.isArray(query.seedSummaries)) {
        discoveredSummaries.push(...query.seedSummaries);
      } else {
        while (true) {
          const listRequest: SyncListPageRequest<TCursor, TSummary, TCheckpoint> = {
            cursor: nextCursor,
            checkpoint: latestCheckpoint,
            query,
            transport,
            authProvider: options.authProvider,
            signal: query.signal,
          };
          const cacheKey = options.source.getListPageCacheKey?.(listRequest) ?? null;
          let page = cacheKey
            ? await cacheStore.get<SyncListPageResult<TCursor, TSummary, TCheckpoint>>(cacheKey)
            : undefined;

          if (page) {
            await emitEvent(options.onEvent, {
              type: "cache-hit",
              stage: "list-page",
              key: cacheKey!,
            });
          } else {
            page = await retryOperation(() => options.source.listPage(listRequest), {
              maxAttempts: Math.max(1, Math.trunc(query.list?.retryAttempts ?? 1)),
              signal: query.signal,
              shouldRetry: (error, signal) =>
                options.source.shouldRetry?.(error, signal) ?? !isSyncCancelledError(error),
              onRetry: async (progress) => {
                await emitEvent(options.onEvent, {
                  type: "list-page-retry",
                  cursor: listRequest.cursor,
                  attemptNumber: progress.nextAttemptNumber,
                  maxAttempts: progress.maxAttempts,
                  message: progress.message,
                });
              },
            });

            if (cacheKey) {
              await cacheStore.set(cacheKey, page);
              await emitEvent(options.onEvent, {
                type: "cache-write",
                stage: "list-page",
                key: cacheKey,
              });
            }
          }

          discoveredSummaries.push(...page.items);
          latestCheckpoint = typeof page.checkpoint === "undefined" ? latestCheckpoint : (page.checkpoint ?? null);

          await emitEvent(options.onEvent, {
            type: "list-page",
            cursor: listRequest.cursor,
            pageCount: page.items.length,
            discoveredCount: dedupeSummaries(options.source, discoveredSummaries).length,
            expectedTotal: page.expectedTotal ?? null,
          });

          nextCursor = page.nextCursor;
          checkpointState = checkpointKey
            ? {
                sourceCheckpoint: latestCheckpoint,
                nextCursor,
                lastProcessedSummaryId: checkpointState?.lastProcessedSummaryId ?? null,
                updatedAt: createTimestamp(),
              }
            : checkpointState;

          if (checkpointKey && checkpointState) {
            await checkpointStore.set(checkpointKey, checkpointState);
            await emitEvent(options.onEvent, {
              type: "checkpoint-saved",
              key: checkpointKey,
              state: checkpointState,
            });
          }

          if (nextCursor === null) {
            break;
          }
        }
      }

      const selectedSummaries = selectSummaries(options.source, query, discoveredSummaries);
      await emitEvent(options.onEvent, {
        type: "discovery-complete",
        discoveredCount: dedupeSummaries(options.source, discoveredSummaries).length,
        selectedCount: selectedSummaries.length,
      });

      let processedCount = 0;
      let skippedCount = 0;
      let failureCount = 0;

      for (let index = 0; index < selectedSummaries.length; index += 1) {
        const summary = selectedSummaries[index]!;
        const summaryIndex = index + 1;

        while (true) {
          try {
            await emitEvent(options.onEvent, {
              type: "summary-start",
              summary,
              index: summaryIndex,
              total: selectedSummaries.length,
            });

            const gateResult = await options.beforeFetchSummary?.({
              summary,
              index: summaryIndex,
              total: selectedSummaries.length,
            });

            if (gateResult?.skip) {
              skippedCount += 1;
              processedCount += 1;
              checkpointState = checkpointKey
                ? {
                    sourceCheckpoint: latestCheckpoint,
                    nextCursor: null,
                    lastProcessedSummaryId: options.source.getSummaryId(summary),
                    updatedAt: createTimestamp(),
                  }
                : checkpointState;

              if (checkpointKey && checkpointState) {
                await checkpointStore.set(checkpointKey, checkpointState);
                await emitEvent(options.onEvent, {
                  type: "checkpoint-saved",
                  key: checkpointKey,
                  state: checkpointState,
                });
              }

              await emitEvent(options.onEvent, {
                type: "summary-skip",
                summary,
                index: summaryIndex,
                total: selectedSummaries.length,
                reason: gateResult.reason,
              });
              break;
            }

            const fetchRequest: SyncFetchRecordRequest<TSummary> = {
              summary,
              query,
              transport,
              authProvider: options.authProvider,
              signal: query.signal,
            };
            const cacheKey = options.source.getRecordCacheKey?.(fetchRequest) ?? null;
            let recordResult = cacheKey
              ? await cacheStore.get<SyncFetchRecordResult<TRecord, TCheckpoint>>(cacheKey)
              : undefined;

            if (recordResult) {
              await emitEvent(options.onEvent, {
                type: "cache-hit",
                stage: "record",
                key: cacheKey!,
              });
            } else {
              recordResult = await retryOperation(() => options.source.fetchRecord(fetchRequest), {
                maxAttempts: Math.max(1, Math.trunc(query.record?.retryAttempts ?? 1)),
                signal: query.signal,
                shouldRetry: (error, signal) =>
                  options.source.shouldRetry?.(error, signal) ?? !isSyncCancelledError(error),
                onRetry: async (progress) => {
                  await emitEvent(options.onEvent, {
                    type: "summary-retry",
                    summary,
                    index: summaryIndex,
                    total: selectedSummaries.length,
                    attemptNumber: progress.nextAttemptNumber,
                    maxAttempts: progress.maxAttempts,
                    message: progress.message,
                  });
                },
              });

              if (cacheKey) {
                await cacheStore.set(cacheKey, recordResult);
                await emitEvent(options.onEvent, {
                  type: "cache-write",
                  stage: "record",
                  key: cacheKey,
                });
              }
            }

            latestCheckpoint =
              typeof recordResult.checkpoint === "undefined" ? latestCheckpoint : (recordResult.checkpoint ?? null);

            await options.onRecord?.({
              summary,
              record: recordResult.record,
              raw: recordResult.raw,
              index: summaryIndex,
              total: selectedSummaries.length,
            });

            processedCount += 1;
            checkpointState = checkpointKey
              ? {
                  sourceCheckpoint: latestCheckpoint,
                  nextCursor: null,
                  lastProcessedSummaryId: options.source.getSummaryId(summary),
                  updatedAt: createTimestamp(),
                }
              : checkpointState;

            if (checkpointKey && checkpointState) {
              await checkpointStore.set(checkpointKey, checkpointState);
              await emitEvent(options.onEvent, {
                type: "checkpoint-saved",
                key: checkpointKey,
                state: checkpointState,
              });
            }

            await emitEvent(options.onEvent, {
              type: "summary-success",
              summary,
              record: recordResult.record,
              raw: recordResult.raw,
              index: summaryIndex,
              total: selectedSummaries.length,
            });
            break;
          } catch (error) {
            if (query.signal?.aborted || isSyncCancelledError(error)) {
              throw toSyncCancelledError(query.signal?.reason ?? error);
            }

            const normalizedError = normalizeError(error);
            const action = await options.onSummaryError?.(normalizedError, {
              summary,
              index: summaryIndex,
              total: selectedSummaries.length,
              attempts: Math.max(1, Math.trunc(query.record?.retryAttempts ?? 1)),
            });

            if (action === "retry") {
              continue;
            }

            if (action === "abort") {
              throw toSyncCancelledError(normalizedError);
            }

            if (action === "throw") {
              throw normalizedError;
            }

            failureCount += 1;
            processedCount += 1;
            await emitEvent(options.onEvent, {
              type: "summary-failure",
              summary,
              index: summaryIndex,
              total: selectedSummaries.length,
              attempts: Math.max(1, Math.trunc(query.record?.retryAttempts ?? 1)),
              error: normalizedError,
            });
            break;
          }
        }
      }

      return {
        discoveredSummaries: dedupeSummaries(options.source, discoveredSummaries),
        selectedSummaries,
        processedCount,
        skippedCount,
        failureCount,
        checkpointState,
      };
    },
  };
}
