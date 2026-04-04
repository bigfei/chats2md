export interface StoredSessionAccount {
  accountId: string;
  userId: string;
  email: string;
  expiresAt?: string;
  secretId: string;
  addedAt: string;
  updatedAt: string;
}

export interface Chats2MdSettings {
  defaultFolder: string;
  accounts: StoredSessionAccount[];
  legacySessionJson: string;
}

export const DEFAULT_SETTINGS: Chats2MdSettings = {
  defaultFolder: "Imports/ChatGPT",
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
  scope: "all" | "single";
  accountId?: string;
  forceRefresh: boolean;
}

export type UpsertAction = "created" | "updated" | "skipped";

export interface ConversationUpsertResult {
  action: UpsertAction;
  filePath: string;
  moved: boolean;
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
