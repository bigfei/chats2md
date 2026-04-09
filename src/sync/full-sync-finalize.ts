import type { SyncRunReport } from "../shared/types";
import type { SyncRunLogger } from "../main/helpers";

export async function finalizeFullSyncRun(
  report: SyncRunReport,
  dependencies: {
    writeSyncReport: (report: SyncRunReport) => Promise<string | null>;
    syncLogger: SyncRunLogger | null;
    logInfo: (message: string) => void;
    logWarn: (message: string) => void;
  },
): Promise<void> {
  try {
    const reportPath = await dependencies.writeSyncReport(report);
    if (reportPath) {
      dependencies.logInfo(`Sync report saved: ${reportPath}`);
    } else {
      dependencies.logInfo("Sync report generation skipped (disabled in settings).");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.logWarn(`Sync report generation failed: ${message}`);
  }

  if (dependencies.syncLogger) {
    await dependencies.syncLogger.flush();
  }
}
