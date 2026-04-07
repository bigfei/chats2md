export function clearStoredSecretPayload(
  settings: { accounts: Array<{ accountId: string; secretId: string }> },
  accountId: string,
  setSecret: (key: string, value: string) => void,
): boolean {
  const existing = settings.accounts.find((account) => account.accountId === accountId);

  if (!existing) {
    return false;
  }

  setSecret(existing.secretId, "");
  return true;
}
