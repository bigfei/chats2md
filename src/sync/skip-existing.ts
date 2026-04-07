export function shouldFetchConversationDetail(
  hasLocalConversation: boolean,
  skipExistingLocalConversations: boolean,
): boolean {
  return !skipExistingLocalConversations || !hasLocalConversation;
}
