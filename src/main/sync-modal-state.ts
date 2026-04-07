export interface SyncModalOpenState {
  syncWorkerActive: boolean;
  activeModalIsSyncing: boolean;
  activeModalCanReopen: boolean;
}

export function shouldRestoreActiveSyncModal(state: SyncModalOpenState): boolean {
  if (state.activeModalCanReopen) {
    return true;
  }

  if (state.syncWorkerActive) {
    return false;
  }

  return state.activeModalIsSyncing;
}
