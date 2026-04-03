export interface Chats2MdSettings {
  defaultFolder: string;
  defaultLimit: number;
  sessionJson: string;
}

export const DEFAULT_SETTINGS: Chats2MdSettings = {
  defaultFolder: "Imports/ChatGPT",
  defaultLimit: 28,
  sessionJson: ""
};

export interface ChatGptRequestConfig {
  accessToken: string;
  accountId: string;
  cookie?: string;
  headers: Record<string, string>;
  userAgent: string;
  expiresAt?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  url: string;
}

export interface ConversationMessage {
  id: string;
  role: string;
  markdown: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  updatedAt: string;
  url: string;
  messages: ConversationMessage[];
}

export interface ImportModalValues {
  folder: string;
  limit: number;
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
