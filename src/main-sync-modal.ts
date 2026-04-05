import { Notice } from "obsidian";

import { runFullSync } from "./full-sync";
import { SyncChatGptModal, type SyncExecutionControl, type SyncProgressReporter } from "./import-modal";
import type { SyncModalValues } from "./types";

export function openSyncModal(host: any): void {
  if (host.syncWorkerActive) {
    if (host.activeSyncModal?.isSyncInProgress() && !host.suppressSyncStatusBarUpdates) {
      host.suppressSyncStatusBarUpdates = false;
      host.activeSyncModal.open();
      return;
    }

    new Notice("A sync job is still stopping in the background. Please wait a moment.");
    return;
  }

  if (host.activeSyncModal?.isSyncInProgress()) {
    host.suppressSyncStatusBarUpdates = false;
    host.activeSyncModal.open();
    return;
  }

  const accounts = host.getAccounts();

  if (accounts.length === 0) {
    new Notice("Add at least one account session in plugin settings before syncing.");
    return;
  }

  let modal: SyncChatGptModal;
  modal = new SyncChatGptModal(host.app, {
    folder: host.settings.defaultFolder,
    conversationPathTemplate: host.settings.conversationPathTemplate,
    assetStorageMode: host.settings.assetStorageMode,
    defaultConversationListLatestLimit: host.settings.conversationListLatestLimit,
    accounts,
    onSubmit: async (values, progress, control) => handleSync(host, values, progress, control, modal),
    onSyncDialogHidden: (reason) => {
      if (reason === "close") {
        host.suppressSyncStatusBarUpdates = true;
        host.clearSyncStatusBar(0, true);
        return;
      }

      host.suppressSyncStatusBarUpdates = false;
    }
  });

  host.activeSyncModal = modal;
  modal.open();
}

export async function handleSync(
  host: any,
  values: SyncModalValues,
  progressModal: SyncProgressReporter,
  control: SyncExecutionControl,
  modal: SyncChatGptModal
): Promise<void> {
  host.settings.defaultFolder = values.folder;
  host.settings.assetStorageMode = values.assetStorageMode;
  await host.saveSettings();

  host.syncWorkerActive = true;
  host.suppressSyncStatusBarUpdates = false;

  try {
    await runFullSync({
      app: host.app,
      manifestVersion: host.manifest.version,
      createSyncRunLogger: (reporter) => host.createSyncRunLogger(reporter, values.folder),
      getSelectedAccounts: (syncValues) => host.getSelectedAccounts(syncValues),
      getRequestConfig: (account) => host.getRequestConfig(account),
      getAccountLabel: (account) => host.getAccountLabel(account),
      getDefaultConversationListLatestLimit: () => host.settings.conversationListLatestLimit,
      getConversationListCache: (accountId) => host.getConversationListCache(accountId),
      saveConversationListCache: (accountId, summaries) => host.saveConversationListCache(accountId, summaries),
      shouldSaveConversationJson: () => host.settings.saveConversationJson,
      saveConversationJsonSidecar: (notePath, payload) => host.saveConversationJsonSidecar(notePath, payload),
      moveConversationJsonSidecar: (sourceNotePath, targetNotePath) =>
        host.moveConversationJsonSidecar(sourceNotePath, targetNotePath),
      syncConversationAssets: (
        requestConfig,
        conversation,
        baseFolder,
        conversationPathTemplate,
        assetStorageMode,
        logger,
        accountLabel,
        conversationIndex,
        totalConversations
      ) => host.syncConversationAssets(
        requestConfig,
        conversation,
        baseFolder,
        conversationPathTemplate,
        assetStorageMode,
        logger,
        accountLabel,
        conversationIndex,
        totalConversations
      ),
      writeSyncReport: (report) => host.writeSyncReport(report),
      buildSyncStatusText: (processed, total, phase) => host.buildSyncStatusText(processed, total, phase),
      setSyncStatusBar: (text, active) => host.setSyncStatusBar(text, active),
      clearSyncStatusBar: (delayMs) => host.clearSyncStatusBar(delayMs)
    }, values, progressModal, control);
  } finally {
    host.syncWorkerActive = false;
    host.suppressSyncStatusBarUpdates = false;
    if (host.activeSyncModal === modal && !modal.isSyncInProgress()) {
      host.activeSyncModal = null;
    }
  }
}
