import {
  CONVERSATION_ACCOUNT_ID_KEY,
  CONVERSATION_CREATED_AT_KEY,
  CONVERSATION_ID_KEY,
  CONVERSATION_LIST_UPDATED_AT_KEY,
  CONVERSATION_TITLE_KEY,
  CONVERSATION_UPDATED_AT_KEY,
  CONVERSATION_USER_ID_KEY,
  type ConversationFrontmatterInfo,
} from "./helpers";
import type { StoredSessionAccount, SyncModalValues } from "../shared/types";

function readFrontmatterString(frontmatter: Record<string, unknown> | undefined, key: string): string {
  const value = frontmatter?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function buildConversationFrontmatter(
  frontmatter: Record<string, unknown> | undefined,
): ConversationFrontmatterInfo {
  return {
    conversationId: readFrontmatterString(frontmatter, CONVERSATION_ID_KEY),
    title: readFrontmatterString(frontmatter, CONVERSATION_TITLE_KEY),
    createdAt: readFrontmatterString(frontmatter, CONVERSATION_CREATED_AT_KEY),
    updatedAt: readFrontmatterString(frontmatter, CONVERSATION_UPDATED_AT_KEY),
    listUpdatedAt: readFrontmatterString(frontmatter, CONVERSATION_LIST_UPDATED_AT_KEY),
    accountId: readFrontmatterString(frontmatter, CONVERSATION_ACCOUNT_ID_KEY),
    userId: readFrontmatterString(frontmatter, CONVERSATION_USER_ID_KEY),
  };
}

export function selectAccountsForSync(
  accounts: StoredSessionAccount[],
  values: SyncModalValues,
): StoredSessionAccount[] {
  const enabledAccounts = accounts.filter((account) => !account.disabled);

  if (values.scope === "all") {
    return enabledAccounts;
  }

  const accountId = (values.accountId ?? "").trim();

  if (!accountId) {
    throw new Error("No account selected for sync.");
  }

  const selected = enabledAccounts.find((account) => account.accountId === accountId);

  if (!selected) {
    throw new Error(`Selected enabled account is no longer available: ${accountId}`);
  }

  return [selected];
}

export function resolveAccountForConversation(
  accounts: StoredSessionAccount[],
  frontmatter: ConversationFrontmatterInfo,
): StoredSessionAccount {
  if (accounts.length === 0) {
    throw new Error("No session account is configured in plugin settings.");
  }

  if (frontmatter.accountId) {
    const byAccountId = accounts.find((account) => account.accountId === frontmatter.accountId);

    if (byAccountId) {
      return byAccountId;
    }
  }

  if (frontmatter.userId) {
    const byUserId = accounts.filter((account) => account.userId === frontmatter.userId);

    if (byUserId.length === 1) {
      const matched = byUserId[0];
      if (matched) {
        return matched;
      }
    }

    if (byUserId.length > 1) {
      throw new Error(
        `Multiple sessions match user_id "${frontmatter.userId}". Re-run full sync to refresh account_id in note frontmatter.`,
      );
    }
  }

  if (accounts.length === 1) {
    const onlyAccount = accounts[0];
    if (onlyAccount) {
      return onlyAccount;
    }
  }

  if (frontmatter.accountId) {
    throw new Error(`No session matches account_id "${frontmatter.accountId}" from note frontmatter.`);
  }

  if (frontmatter.userId) {
    throw new Error(`No session matches user_id "${frontmatter.userId}" from note frontmatter.`);
  }

  throw new Error(`Note frontmatter is missing ${CONVERSATION_ACCOUNT_ID_KEY} and ${CONVERSATION_USER_ID_KEY}.`);
}
