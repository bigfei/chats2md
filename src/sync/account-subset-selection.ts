import {
  filterConversationSummariesByCreatedDateRange,
  filterConversationSummariesByLatestCreatedCount,
  getConversationCreatedAtSpan,
  toIsoUtcDate,
} from "./date-range";

import type {
  ConversationSummary,
  ConversationSyncDateRangePromptContext,
  ConversationSyncDateRangeSelection,
} from "../shared/types";

type SelectableConversationSubset =
  | { mode: "all"; skipExistingLocalConversations: boolean }
  | { mode: "range"; startDate: string; endDate: string; skipExistingLocalConversations: boolean }
  | { mode: "latest-count"; count: number; skipExistingLocalConversations: boolean };

export interface OpenAccountSubsetSelectionPromptParams {
  accountLabel: string;
  accountIndex: number;
  totalAccounts: number;
  summaries: ConversationSummary[];
  skipExistingLocalConversations: boolean;
}

export interface OpenAccountSubsetSelectionPromptOptions {
  ensureCanContinue(): Promise<boolean>;
  setPreparing(message: string): void;
  logInfo(message: string): void;
  selectDateRange(context: ConversationSyncDateRangePromptContext): Promise<ConversationSyncDateRangeSelection>;
}

interface OpenAccountSubsetSelectionPromptResultBase {
  discoveredCount: number;
  discoveredRangeLabel: string;
}

export type OpenAccountSubsetSelectionPromptResult =
  | (OpenAccountSubsetSelectionPromptResultBase & {
      status: "selected";
      selection: SelectableConversationSubset;
    })
  | (OpenAccountSubsetSelectionPromptResultBase & {
      status: "no-selection";
    })
  | (OpenAccountSubsetSelectionPromptResultBase & {
      status: "skip-account";
    })
  | (OpenAccountSubsetSelectionPromptResultBase & {
      status: "stop";
    });

export function applyConversationSubsetSelection(
  summaries: ConversationSummary[],
  selection: SelectableConversationSubset,
): ConversationSummary[] {
  if (selection.mode === "range") {
    return filterConversationSummariesByCreatedDateRange(summaries, selection.startDate, selection.endDate);
  }

  if (selection.mode === "latest-count") {
    return filterConversationSummariesByLatestCreatedCount(summaries, selection.count);
  }

  return summaries;
}

export async function openAccountSubsetSelectionPrompt(
  params: OpenAccountSubsetSelectionPromptParams,
  options: OpenAccountSubsetSelectionPromptOptions,
): Promise<OpenAccountSubsetSelectionPromptResult> {
  const discoveredCount = params.summaries.length;
  const createdAtSpan = getConversationCreatedAtSpan(params.summaries);
  const discoveredStartDate = toIsoUtcDate(createdAtSpan?.minCreatedAt ?? "");
  const discoveredEndDate = toIsoUtcDate(createdAtSpan?.maxCreatedAt ?? "");
  const discoveredRangeLabel =
    discoveredStartDate && discoveredEndDate ? `${discoveredStartDate} to ${discoveredEndDate}` : "unknown";

  if (discoveredCount === 0 || !createdAtSpan) {
    return {
      status: "no-selection",
      discoveredCount,
      discoveredRangeLabel,
    };
  }

  if (!(await options.ensureCanContinue())) {
    return {
      status: "stop",
      discoveredCount,
      discoveredRangeLabel,
    };
  }

  options.setPreparing(
    `Syncing ${params.accountLabel} (${params.accountIndex + 1}/${params.totalAccounts}): choose conversation filter...`,
  );
  options.logInfo(
    `[${params.accountLabel}] Conversation subset selection opened for created_at range ${discoveredRangeLabel}. Waiting for selection.`,
  );

  const selection = await options.selectDateRange({
    accountLabel: params.accountLabel,
    discoveredCount,
    minCreatedAt: createdAtSpan.minCreatedAt,
    maxCreatedAt: createdAtSpan.maxCreatedAt,
    skipExistingLocalConversations: params.skipExistingLocalConversations,
  });

  if (!(await options.ensureCanContinue())) {
    return {
      status: "stop",
      discoveredCount,
      discoveredRangeLabel,
    };
  }

  if (selection.mode === "skip-account") {
    return {
      status: "skip-account",
      discoveredCount,
      discoveredRangeLabel,
    };
  }

  return {
    status: "selected",
    discoveredCount,
    discoveredRangeLabel,
    selection,
  };
}
