import { Notice } from "obsidian";

import { runFullSync } from "../sync/full-sync";
import { shouldRestoreActiveSyncModal } from "./sync-modal-state";
import { SyncChatGptModal, type SyncExecutionControl, type SyncProgressReporter } from "../ui/import-modal";
import type { SyncModalValues } from "../shared/types";

function ensureSyncModalCanOpen(host: any): boolean {
  if (
    shouldRestoreActiveSyncModal({
      syncWorkerActive: host.syncWorkerActive,
      activeModalIsSyncing: Boolean(host.activeSyncModal?.isSyncInProgress()),
      activeModalCanReopen: Boolean(host.activeSyncModal?.canReopenWhileRunning()),
    })
  ) {
    host.suppressSyncStatusBarUpdates = false;
    host.activeSyncModal.open();
    return false;
  }

  if (host.syncWorkerActive) {
    new Notice("A sync job is still stopping in the background. Please wait a moment.");
    return false;
  }

  if (host.activeSyncModal?.isSyncInProgress()) {
    host.suppressSyncStatusBarUpdates = false;
    host.activeSyncModal.open();
    return false;
  }

  return true;
}

function createSyncModal(host: any): SyncChatGptModal | null {
  const accounts = host.getAccounts();

  if (accounts.length === 0) {
    new Notice("Add at least one account session in plugin settings before syncing.");
    return null;
  }

  const modal: SyncChatGptModal = new SyncChatGptModal(host.app, {
    folder: host.settings.defaultFolder,
    conversationPathTemplate: host.settings.conversationPathTemplate,
    assetStorageMode: host.settings.assetStorageMode,
    initialSkipExistingLocalConversations: host.settings.skipExistingLocalConversations,
    accounts,
    onSubmit: async (values, progress, control): Promise<void> => handleSync(host, values, progress, control, modal),
    onSyncDialogHidden: (reason) => {
      if (reason === "stop") {
        host.suppressSyncStatusBarUpdates = true;
        host.clearSyncStatusBar(0, true);
        return;
      }

      host.suppressSyncStatusBarUpdates = false;
    },
  });

  host.activeSyncModal = modal;
  return modal;
}

export function openSyncModal(host: any): void {
  if (!ensureSyncModalCanOpen(host)) {
    return;
  }

  const modal = createSyncModal(host);

  if (!modal) {
    return;
  }

  modal.open();
}

export function startAllAccountsSync(host: any): void {
  if (!ensureSyncModalCanOpen(host)) {
    return;
  }

  const modal = createSyncModal(host);

  if (!modal) {
    return;
  }

  modal.open();
  void modal.startSync({
    folder: host.settings.defaultFolder,
    conversationPathTemplate: host.settings.conversationPathTemplate,
    assetStorageMode: host.settings.assetStorageMode,
    skipExistingLocalConversations: host.settings.skipExistingLocalConversations,
    scope: "all",
  });
}

export async function handleSync(
  host: any,
  values: SyncModalValues,
  progressModal: SyncProgressReporter,
  control: SyncExecutionControl,
  modal: SyncChatGptModal,
): Promise<void> {
  host.settings.defaultFolder = values.folder;
  host.settings.assetStorageMode = values.assetStorageMode;
  host.settings.skipExistingLocalConversations = values.skipExistingLocalConversations;
  await host.saveSettings();

  host.syncWorkerActive = true;
  host.suppressSyncStatusBarUpdates = false;

  try {
    await runFullSync(
      {
        app: host.app,
        manifestVersion: host.manifest.version,
        createSyncRunLogger: (reporter) => host.createSyncRunLogger(reporter, values.folder),
        getSelectedAccounts: (syncValues) => host.getSelectedAccounts(syncValues),
        getRequestConfig: (account) => host.getRequestConfig(account),
        getAccountLabel: (account) => host.getAccountLabel(account),
        shouldSaveConversationJson: () => host.settings.saveConversationJson,
        shouldGenerateSyncReport: () => host.settings.generateSyncReport,
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
          totalConversations,
          stopSignal,
        ) =>
          host.syncConversationAssets(
            requestConfig,
            conversation,
            baseFolder,
            conversationPathTemplate,
            assetStorageMode,
            logger,
            accountLabel,
            conversationIndex,
            totalConversations,
            stopSignal,
          ),
        writeSyncReport: (report) => host.writeSyncReport(report),
        buildSyncStatusText: (processed, total, phase) => host.buildSyncStatusText(processed, total, phase),
        setSyncStatusBar: (text, active) => host.setSyncStatusBar(text, active),
        clearSyncStatusBar: (delayMs) => host.clearSyncStatusBar(delayMs),
        getSyncTuning: () => host.settings.syncTuning,
      },
      values,
      progressModal,
      control,
    );
  } finally {
    if (host.settings.skipExistingLocalConversations !== values.skipExistingLocalConversations) {
      host.settings.skipExistingLocalConversations = values.skipExistingLocalConversations;
      await host.saveSettings();
    }

    host.syncWorkerActive = false;
    host.suppressSyncStatusBarUpdates = false;
    if (host.activeSyncModal === modal && !modal.isSyncInProgress()) {
      host.activeSyncModal = null;
    }
  }
}
