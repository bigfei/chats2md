import { formatAssetStorageMode } from "../main/helpers";
import type { SyncReportConversationEntry, SyncRunReport } from "../shared/types";

function stripMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

function escapeWikiLinkLabel(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/]]/g, "\\]\\]");
}

function formatFileWikiLink(path: string): string {
  const label = path.split("/").pop() || path;
  return `[[${path}|${escapeWikiLinkLabel(label)}]]`;
}

function formatConversationReference(entry: SyncReportConversationEntry): string {
  if (!entry.notePath) {
    return `${entry.title} (\`${entry.conversationId}\`)`;
  }

  const noteTarget = stripMarkdownExtension(entry.notePath);
  return `[[${noteTarget}|${escapeWikiLinkLabel(entry.title)}]] (\`${entry.conversationId}\`)`;
}

function formatConversationSource(entry: SyncReportConversationEntry): string {
  if (!entry.conversationUrl) {
    return "";
  }

  return ` · [ChatGPT](${entry.conversationUrl})`;
}

function renderConversationSection(title: string, entries: SyncReportConversationEntry[]): string {
  const lines = [`## ${title}`, ""];

  if (entries.length === 0) {
    lines.push("_None_", "");
    return lines.join("\n");
  }

  for (const entry of entries) {
    lines.push(`- ${formatConversationReference(entry)}${formatConversationSource(entry)}`);
    if (entry.message && entry.message.trim().length > 0) {
      lines.push(`  - ${entry.message.trim()}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function renderSyncRunReport(report: SyncRunReport): string {
  const logReference = report.logPath ? formatFileWikiLink(report.logPath) : "_Unavailable_";
  const lines = [
    "# Chats2MD Sync Report",
    "",
    "## Run",
    "",
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Status: ${report.status}`,
    `- Sync log: ${logReference}`,
    `- Scope: ${report.scope}`,
    `- Sync folder: ${report.folder}`,
    `- Layout template: ${report.conversationPathTemplate}`,
    `- Asset storage: ${formatAssetStorageMode(report.assetStorageMode)}`,
    `- Accounts: ${report.accounts.length > 0 ? report.accounts.map((account) => `${account.label} (${account.accountId})`).join(", ") : "None"}`,
    "",
    "## Summary",
    "",
    `- Conversations discovered from list fetch: ${report.discoveredTotal}`,
    `- Conversations selected for this run: ${report.selectedTotal}`,
    `- Created: ${report.counts.created}`,
    `- Updated: ${report.counts.updated}`,
    `- Moved: ${report.counts.moved}`,
    `- Skipped: ${report.counts.skipped}`,
    `- Failed: ${report.counts.failed}`,
    "",
    renderConversationSection("Created", report.created),
    renderConversationSection("Updated", report.updated),
    renderConversationSection("Moved", report.moved),
    renderConversationSection("Failed", report.failed),
  ];

  return `${lines.join("\n")}\n`;
}
