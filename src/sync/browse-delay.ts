import { SyncCancelledError, sleepWithAbort } from "./cancellation";
import { shouldFetchConversationDetail } from "./skip-existing";

export const MIN_CONVERSATION_BROWSE_DELAY_MS = 3000;
export const MAX_CONVERSATION_BROWSE_DELAY_MS = 15000;

export interface BrowseDelayControl {
  waitIfPaused(): Promise<void>;
  shouldStop(): boolean;
  getStopSignal(): AbortSignal;
}

type SleepWithAbortFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ConversationDetailFetchPreparationResult {
  shouldFetch: boolean;
  delayMs: number | null;
}

export interface ConversationBrowseDelayRange {
  minDelayMs: number;
  maxDelayMs: number;
}

function normalizeDelayRange(range?: Partial<ConversationBrowseDelayRange>): ConversationBrowseDelayRange {
  const minDelayMs = Number.isFinite(range?.minDelayMs)
    ? Math.max(0, Math.trunc(range?.minDelayMs ?? MIN_CONVERSATION_BROWSE_DELAY_MS))
    : MIN_CONVERSATION_BROWSE_DELAY_MS;
  const requestedMaxDelayMs = Number.isFinite(range?.maxDelayMs)
    ? Math.max(0, Math.trunc(range?.maxDelayMs ?? MAX_CONVERSATION_BROWSE_DELAY_MS))
    : MAX_CONVERSATION_BROWSE_DELAY_MS;

  return {
    minDelayMs,
    maxDelayMs: Math.max(minDelayMs, requestedMaxDelayMs),
  };
}

export function computeConversationBrowseDelayMs(
  randomValue: number,
  range?: Partial<ConversationBrowseDelayRange>,
): number {
  const clampedRandomValue = Number.isFinite(randomValue) ? Math.max(0, Math.min(1, randomValue)) : 0;
  const normalizedRange = normalizeDelayRange(range);

  return (
    normalizedRange.minDelayMs +
    Math.round((normalizedRange.maxDelayMs - normalizedRange.minDelayMs) * clampedRandomValue)
  );
}

export function formatConversationBrowseDelay(delayMs: number): string {
  return `${(delayMs / 1000).toFixed(1)}s`;
}

export async function prepareConversationDetailFetch(
  hasLocalConversation: boolean,
  skipExistingLocalConversations: boolean,
  control: BrowseDelayControl,
  options: {
    randomValue?: number;
    sleep?: SleepWithAbortFn;
    onDelay?: (delayMs: number) => void;
    delayRange?: Partial<ConversationBrowseDelayRange>;
  } = {},
): Promise<ConversationDetailFetchPreparationResult> {
  if (!shouldFetchConversationDetail(hasLocalConversation, skipExistingLocalConversations)) {
    return {
      shouldFetch: false,
      delayMs: null,
    };
  }

  await control.waitIfPaused();

  if (control.shouldStop()) {
    throw new SyncCancelledError();
  }

  const delayMs = computeConversationBrowseDelayMs(options.randomValue ?? Math.random(), options.delayRange);
  options.onDelay?.(delayMs);
  await (options.sleep ?? sleepWithAbort)(delayMs, control.getStopSignal());

  return {
    shouldFetch: true,
    delayMs,
  };
}
