import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONVERSATION_BROWSE_DELAY_MS,
  MIN_CONVERSATION_BROWSE_DELAY_MS,
  computeConversationBrowseDelayMs,
  formatConversationBrowseDelay,
  prepareConversationDetailFetch,
} from "../src/sync/browse-delay.ts";
import { isSyncCancelledError } from "../src/sync/cancellation.ts";

function createControl(): {
  control: {
    waitIfPaused(): Promise<void>;
    shouldStop(): boolean;
    getStopSignal(): AbortSignal;
  };
  abort(reason?: unknown): void;
} {
  const controller = new AbortController();

  return {
    control: {
      async waitIfPaused(): Promise<void> {
        return Promise.resolve();
      },
      shouldStop(): boolean {
        return controller.signal.aborted;
      },
      getStopSignal(): AbortSignal {
        return controller.signal;
      },
    },
    abort(reason?: unknown): void {
      controller.abort(reason);
    },
  };
}

test("computeConversationBrowseDelayMs maps the low end to 3000ms", () => {
  assert.equal(computeConversationBrowseDelayMs(0), MIN_CONVERSATION_BROWSE_DELAY_MS);
});

test("computeConversationBrowseDelayMs maps the high end to 15000ms", () => {
  assert.equal(computeConversationBrowseDelayMs(1), MAX_CONVERSATION_BROWSE_DELAY_MS);
});

test("computeConversationBrowseDelayMs keeps mid-range values within bounds", () => {
  const delayMs = computeConversationBrowseDelayMs(0.5);

  assert.equal(delayMs, 9000);
  assert.equal(delayMs >= MIN_CONVERSATION_BROWSE_DELAY_MS, true);
  assert.equal(delayMs <= MAX_CONVERSATION_BROWSE_DELAY_MS, true);
});

test("formatConversationBrowseDelay renders one decimal place in seconds", () => {
  assert.equal(formatConversationBrowseDelay(12345), "12.3s");
});

test("prepareConversationDetailFetch applies one browse delay before fetching", async () => {
  const { control } = createControl();
  const events: string[] = [];

  const result = await prepareConversationDetailFetch(false, true, control, {
    randomValue: 0.5,
    onDelay: (delayMs) => {
      events.push(`delay:${delayMs}`);
    },
    sleep: async (delayMs) => {
      events.push(`sleep:${delayMs}`);
    },
  });

  assert.deepEqual(result, {
    shouldFetch: true,
    delayMs: 9000,
  });
  assert.deepEqual(events, ["delay:9000", "sleep:9000"]);
});

test("prepareConversationDetailFetch does not invoke delay when local conversation is skipped", async () => {
  const { control } = createControl();
  let slept = false;

  const result = await prepareConversationDetailFetch(true, true, control, {
    sleep: async () => {
      slept = true;
    },
  });

  assert.deepEqual(result, {
    shouldFetch: false,
    delayMs: null,
  });
  assert.equal(slept, false);
});

test("prepareConversationDetailFetch stops cleanly when aborted during the browse delay", async () => {
  const { control, abort } = createControl();
  const pending = prepareConversationDetailFetch(false, true, control, {
    randomValue: 0,
  });

  abort("Sync stopped by user.");

  await assert.rejects(pending, (error: unknown) => {
    assert.equal(isSyncCancelledError(error), true);
    return true;
  });
});
