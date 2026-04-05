export function buildSyncStatusText(processed: number, total: number, phase: string): string {
  if (total > 0) {
    const percent = Math.round((processed / total) * 100);
    return `ChatGPT sync: ${processed}/${total} (${percent}%) - ${phase}`;
  }

  return `ChatGPT sync: ${phase}`;
}

export function setSyncStatusBar(host: any, text: string, active = false): void {
  if (host.suppressSyncStatusBarUpdates) {
    return;
  }

  if (host.syncStatusClearTimer !== null) {
    window.clearTimeout(host.syncStatusClearTimer);
    host.syncStatusClearTimer = null;
  }

  if (!host.syncStatusBarEl) {
    return;
  }

  host.syncStatusBarEl.textContent = text;
  host.syncStatusBarEl.style.display = "";
  host.syncStatusBarEl.setAttribute(
    "aria-label",
    active && host.activeSyncModal?.isSyncInProgress() ? `${text} (click to reopen dialog)` : text,
  );
}

export function clearSyncStatusBar(host: any, delayMs = 0, force = false): void {
  if (!host.syncStatusBarEl) {
    return;
  }

  if (host.syncStatusClearTimer !== null) {
    window.clearTimeout(host.syncStatusClearTimer);
    host.syncStatusClearTimer = null;
  }

  const clear = () => {
    if (!host.syncStatusBarEl) {
      return;
    }

    if (!force && host.activeSyncModal?.isSyncInProgress()) {
      return;
    }

    host.syncStatusBarEl.textContent = "";
    host.syncStatusBarEl.style.display = "none";
    host.syncStatusBarEl.removeAttribute("aria-label");
  };

  if (delayMs <= 0) {
    clear();
    return;
  }

  host.syncStatusClearTimer = window.setTimeout(() => {
    host.syncStatusClearTimer = null;
    clear();
  }, delayMs);
}
