import { MarkdownView, Menu, Notice, TFile, type Workspace } from "obsidian";

import { FORCE_SYNC_ACTION_LABEL } from "./main-helpers";

interface ForceSyncUiCallbacks {
  isSyncing(): boolean;
  isEligibleFile(file: TFile | null): boolean;
  onForceSync(file: TFile): Promise<void>;
}

export class ForceSyncUiController {
  private readonly actionEls = new WeakMap<MarkdownView, HTMLElement>();
  private readonly workspace: Workspace;
  private readonly callbacks: ForceSyncUiCallbacks;

  constructor(workspace: Workspace, callbacks: ForceSyncUiCallbacks) {
    this.workspace = workspace;
    this.callbacks = callbacks;
  }

  refreshMarkdownSyncActions(): void {
    this.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) {
        return;
      }

      this.ensureMarkdownSyncAction(leaf.view);
    });
  }

  addForceSyncMenuItem(menu: Menu, file: TFile): void {
    if (!this.callbacks.isEligibleFile(file)) {
      return;
    }

    menu.addItem((item) => {
      item
        .setTitle(FORCE_SYNC_ACTION_LABEL)
        .setIcon("refresh-cw")
        .setDisabled(this.callbacks.isSyncing())
        .onClick(() => {
          void this.callbacks.onForceSync(file);
        });
    });
  }

  private ensureMarkdownSyncAction(view: MarkdownView): void {
    let actionEl = this.actionEls.get(view);

    if (!actionEl) {
      actionEl = view.addAction("refresh-cw", FORCE_SYNC_ACTION_LABEL, () => {
        void this.forceSyncConversationFromView(view);
      });
      actionEl.classList.add("chats2md-note-sync-action");
      this.actionEls.set(view, actionEl);
    }

    this.updateMarkdownSyncActionVisibility(view, actionEl);
  }

  private updateMarkdownSyncActionVisibility(view: MarkdownView, actionEl: HTMLElement): void {
    actionEl.style.display = this.callbacks.isEligibleFile(view.file) ? "" : "none";
  }

  private async forceSyncConversationFromView(view: MarkdownView): Promise<void> {
    const file = view.file;

    if (!(file instanceof TFile)) {
      new Notice("Open a markdown note before forcing sync.");
      return;
    }

    await this.callbacks.onForceSync(file);
    this.refreshMarkdownSyncActions();
  }
}
