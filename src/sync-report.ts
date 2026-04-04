import type { SyncReportConversationEntry, SyncRunReport } from "./types";

function stripMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

function escapeWikiLinkLabel(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/]]/g, "\\]\\]");
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
  const lines = [
    "# Chats2MD Sync Report",
    "",
    "## Run",
    "",
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Status: ${report.status}`,
    `- Scope: ${report.scope}`,
    `- Sync folder: ${report.folder}`,
    `- Layout template: ${report.conversationPathTemplate}`,
    `- Accounts: ${report.accounts.length > 0 ? report.accounts.map((account) => `${account.label} (${account.accountId})`).join(", ") : "None"}`,
    "",
    "## Summary",
    "",
    `- Total conversations discovered: ${report.total}`,
    `- Created: ${report.counts.created}`,
    `- Updated: ${report.counts.updated}`,
    `- Moved: ${report.counts.moved}`,
    `- Skipped: ${report.counts.skipped}`,
    `- Failed: ${report.counts.failed}`,
    "",
    renderConversationSection("Created", report.created),
    renderConversationSection("Updated", report.updated),
    renderConversationSection("Moved", report.moved),
    renderConversationSection("Failed", report.failed)
  ];

  return `${lines.join("\n")}\n`;
}
