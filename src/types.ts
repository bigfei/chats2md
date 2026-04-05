export interface StoredSessionAccount {
  accountId: string;
  userId: string;
  email: string;
  expiresAt?: string;
  secretId: string;
  addedAt: string;
  updatedAt: string;
}

export type AssetStorageMode = "global_by_conversation" | "with_conversation";

export interface Chats2MdSettings {
  defaultFolder: string;
  conversationPathTemplate: string;
  assetStorageMode: AssetStorageMode;
  debugLogging: boolean;
  saveConversationJson: boolean;
  accounts: StoredSessionAccount[];
  legacySessionJson: string;
}

export const DEFAULT_SETTINGS: Chats2MdSettings = {
  defaultFolder: "Imports/ChatGPT",
  conversationPathTemplate: "{date}/{slug}",
  assetStorageMode: "global_by_conversation",
  debugLogging: false,
  saveConversationJson: false,
  accounts: [],
  legacySessionJson: ""
};

export interface ChatGptRequestConfig {
  accessToken: string;
  accountId: string;
  userId: string;
  userEmail: string;
  cookie?: string;
  headers: Record<string, string>;
  userAgent: string;
  expiresAt?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface ConversationMessage {
  id: string;
  role: string;
  markdown: string;
}

export type ConversationFileReferenceKind = "image" | "attachment" | "citation";

export interface ConversationFileReference {
  fileId: string;
  kind: ConversationFileReferenceKind;
  logicalName: string;
  placeholder: string;
}

export interface ConversationAssetLink {
  path: string;
  fileName: string;
}

export type ConversationAssetLinkMap = Record<string, ConversationAssetLink>;

export interface ConversationDetail {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  messages: ConversationMessage[];
  fileReferences: ConversationFileReference[];
}

export interface SyncModalValues {
  folder: string;
  conversationPathTemplate: string;
  assetStorageMode: AssetStorageMode;
  scope: "all" | "single";
  accountId?: string;
  forceRefresh: boolean;
}

export interface ConversationSyncDateRangePromptContext {
  accountLabel: string;
  discoveredCount: number;
  minUpdatedAt: string;
  maxUpdatedAt: string;
}

export type ConversationSyncDateRangeSelection =
  | { mode: "all" }
  | { mode: "range"; startDate: string; endDate: string }
  | { mode: "skip-account" };

export type UpsertAction = "created" | "updated" | "skipped";

export interface ConversationUpsertResult {
  action: UpsertAction;
  filePath: string;
  moved: boolean;
  previousFilePath?: string;
}

export interface ImportProgressCounts {
  created: number;
  updated: number;
  moved: number;
  skipped: number;
  failed: number;
}

export interface ImportResult extends ImportProgressCounts {
  folder: string;
  total: number;
}

export interface ImportFailure {
  id: string;
  title: string;
  message: string;
  attempts: number;
}

export type SyncRunStatus = "completed" | "failed" | "stopped";

export interface SyncReportConversationEntry {
  accountId: string;
  accountLabel: string;
  conversationId: string;
  title: string;
  conversationUrl: string | null;
  notePath: string | null;
  message?: string;
}

export interface SyncRunReport {
  startedAt: string;
  finishedAt: string;
  status: SyncRunStatus;
  folder: string;
  conversationPathTemplate: string;
  assetStorageMode: AssetStorageMode;
  scope: "all" | "single";
  accounts: Array<{ accountId: string; label: string }>;
  total: number;
  counts: ImportProgressCounts;
  created: SyncReportConversationEntry[];
  updated: SyncReportConversationEntry[];
  moved: SyncReportConversationEntry[];
  failed: SyncReportConversationEntry[];
}
