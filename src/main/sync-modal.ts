import { Notice } from "obsidian";

import { runFullSync } from "../sync/full-sync";
import { shouldRestoreActiveSyncModal } from "./sync-modal-state";
import { SyncChatGptModal, type SyncExecutionControl, type SyncProgressReporter } from "../ui/import-modal";
import type { SyncModalValues } from "../shared/types";
import type {
  ChatGptRequestConfig,
  Chats2MdSettings,
  ConversationAssetLinkMap,
  ConversationDetail,
  StoredSessionAccount,
  SyncRunReport,
  SyncTuningSettings,
} from "../shared/types";
import type { SyncRunLogger } from "./helpers";
import type { AccountHealthResult } from "./account-health";
import type { SyncStatusHost } from "./sync-status";

export interface SyncModalHost extends SyncStatusHost {
  app: import("obsidian").App;
  manifest: {
    version: string;
  };
  settings: Chats2MdSettings;
  getSyncWorkerActive(): boolean;
  setSyncWorkerActive(value: boolean): void;
  setSuppressSyncStatusBarUpdates(value: boolean): void;
  setActiveSyncModal(value: SyncChatGptModal | null): void;
  saveSettings(): Promise<void>;
  getAccounts(): StoredSessionAccount[];
  getAllConfiguredAccounts(): StoredSessionAccount[];
  getSelectedAccounts(values: SyncModalValues): StoredSessionAccount[];
  checkAccountHealth(account: StoredSessionAccount): Promise<AccountHealthResult>;
  getRequestConfig(account: StoredSessionAccount): ChatGptRequestConfig;
  getAccountLabel(account: StoredSessionAccount): string;
  createSyncRunLogger(progressSink: { log(message: string): void }, syncFolder: string): Promise<SyncRunLogger>;
  saveConversationJsonSidecar(notePath: string, payload: unknown): Promise<string>;
  moveConversationJsonSidecar(sourceNotePath: string, targetNotePath: string): Promise<boolean>;
  syncConversationAssets(
    requestConfig: ChatGptRequestConfig,
    conversation: ConversationDetail,
    baseFolder: string,
    conversationPathTemplate: string,
    assetStorageMode: "global_by_conversation" | "with_conversation",
    logger: SyncRunLogger | null,
    accountLabel: string,
    conversationIndex: number,
    totalConversations: number,
    stopSignal?: AbortSignal,
  ): Promise<ConversationAssetLinkMap>;
  writeSyncReport(report: SyncRunReport): Promise<string | null>;
  buildSyncStatusText(processed: number, total: number, phase: string): string;
  setSyncStatusBar(text: string, active?: boolean): void;
  clearSyncStatusBar(delayMs?: number, force?: boolean): void;
  getSyncTuning(): SyncTuningSettings;
}

function ensureSyncModalCanOpen(host: SyncModalHost): boolean {
  const activeSyncModal = host.getActiveSyncModal();
  if (
    shouldRestoreActiveSyncModal({
      syncWorkerActive: host.getSyncWorkerActive(),
      activeModalIsSyncing: Boolean(activeSyncModal?.isSyncInProgress()),
      activeModalCanReopen: Boolean(activeSyncModal?.canReopenWhileRunning()),
    })
  ) {
    host.setSuppressSyncStatusBarUpdates(false);
    activeSyncModal?.open();
    return false;
  }

  if (host.getSyncWorkerActive()) {
    new Notice("A sync job is still stopping in the background. Please wait a moment.");
    return false;
  }

  if (activeSyncModal?.isSyncInProgress()) {
    host.setSuppressSyncStatusBarUpdates(false);
    activeSyncModal.open();
    return false;
  }

  return true;
}

function createSyncModal(host: SyncModalHost): SyncChatGptModal | null {
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
        host.setSuppressSyncStatusBarUpdates(true);
        host.clearSyncStatusBar(0, true);
        return;
      }

      host.setSuppressSyncStatusBarUpdates(false);
    },
  });

  host.setActiveSyncModal(modal);
  return modal;
}

export function openSyncModal(host: SyncModalHost): void {
  if (!ensureSyncModalCanOpen(host)) {
    return;
  }

  const modal = createSyncModal(host);

  if (!modal) {
    return;
  }

  modal.open();
}

export function startAllAccountsSync(host: SyncModalHost): void {
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
  host: SyncModalHost,
  values: SyncModalValues,
  progressModal: SyncProgressReporter,
  control: SyncExecutionControl,
  modal: SyncChatGptModal,
): Promise<void> {
  host.settings.defaultFolder = values.folder;
  host.settings.assetStorageMode = values.assetStorageMode;
  host.settings.skipExistingLocalConversations = values.skipExistingLocalConversations;
  await host.saveSettings();

  host.setSyncWorkerActive(true);
  host.setSuppressSyncStatusBarUpdates(false);

  try {
    await runFullSync(
      {
        app: host.app,
        manifestVersion: host.manifest.version,
        createSyncRunLogger: (reporter) => host.createSyncRunLogger(reporter, values.folder),
        getAllConfiguredAccounts: () => host.getAllConfiguredAccounts(),
        getSelectedAccounts: (syncValues) => host.getSelectedAccounts(syncValues),
        checkAccountHealth: (account) => host.checkAccountHealth(account),
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

    host.setSyncWorkerActive(false);
    host.setSuppressSyncStatusBarUpdates(false);
    if (host.getActiveSyncModal() === modal && !modal.isSyncInProgress()) {
      host.setActiveSyncModal(null);
    }
  }
}
