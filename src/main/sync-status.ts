export interface SyncStatusHost {
  getSuppressSyncStatusBarUpdates(): boolean;
  getSyncStatusClearTimer(): number | null;
  setSyncStatusClearTimer(value: number | null): void;
  getSyncStatusBarEl(): HTMLElement | null;
  getActiveSyncModal(): {
    isSyncInProgress(): boolean;
    canReopenWhileRunning(): boolean;
    open(): void;
  } | null;
}

export function buildSyncStatusText(processed: number, total: number, phase: string): string {
  if (total > 0) {
    const percent = Math.round((processed / total) * 100);
    return `ChatGPT sync: ${processed}/${total} (${percent}%) - ${phase}`;
  }

  return `ChatGPT sync: ${phase}`;
}

export function setSyncStatusBar(host: SyncStatusHost, text: string, active = false): void {
  if (host.getSuppressSyncStatusBarUpdates()) {
    return;
  }

  const syncStatusClearTimer = host.getSyncStatusClearTimer();
  if (syncStatusClearTimer !== null) {
    window.clearTimeout(syncStatusClearTimer);
    host.setSyncStatusClearTimer(null);
  }

  const syncStatusBarEl = host.getSyncStatusBarEl();
  if (!syncStatusBarEl) {
    return;
  }

  syncStatusBarEl.textContent = text;
  syncStatusBarEl.classList.remove("is-hidden");
  syncStatusBarEl.setAttribute(
    "aria-label",
    active && host.getActiveSyncModal()?.isSyncInProgress() ? `${text} (click to reopen dialog)` : text,
  );
}

export function clearSyncStatusBar(host: SyncStatusHost, delayMs = 0, force = false): void {
  if (!host.getSyncStatusBarEl()) {
    return;
  }

  const syncStatusClearTimer = host.getSyncStatusClearTimer();
  if (syncStatusClearTimer !== null) {
    window.clearTimeout(syncStatusClearTimer);
    host.setSyncStatusClearTimer(null);
  }

  const clear = () => {
    const syncStatusBarEl = host.getSyncStatusBarEl();
    if (!syncStatusBarEl) {
      return;
    }

    if (!force && host.getActiveSyncModal()?.isSyncInProgress()) {
      return;
    }

    syncStatusBarEl.textContent = "";
    syncStatusBarEl.classList.add("is-hidden");
    syncStatusBarEl.removeAttribute("aria-label");
  };

  if (delayMs <= 0) {
    clear();
    return;
  }

  host.setSyncStatusClearTimer(window.setTimeout(() => {
    host.setSyncStatusClearTimer(null);
    clear();
  }, delayMs));
}
