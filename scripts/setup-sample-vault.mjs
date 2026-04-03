import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleVaultRoot = path.join(pluginRoot, "sample-vault");
const pluginDir = path.join(sampleVaultRoot, ".obsidian", "plugins", "chats2md");
const communityPluginsPath = path.join(sampleVaultRoot, ".obsidian", "community-plugins.json");

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function replaceWithSymlink(sourcePath, targetPath) {
  if (await exists(targetPath)) {
    await rm(targetPath, { force: true });
  }

  await symlink(sourcePath, targetPath);
}

async function ensurePluginEnabled() {
  let pluginIds = [];

  if (await exists(communityPluginsPath)) {
    const raw = await readFile(communityPluginsPath, "utf8");
    pluginIds = JSON.parse(raw);
  }

  if (!pluginIds.includes("chats2md")) {
    pluginIds.push("chats2md");
  }

  await writeFile(communityPluginsPath, `${JSON.stringify(pluginIds, null, 2)}\n`, "utf8");
}

async function main() {
  const requiredFiles = ["main.js", "manifest.json", "styles.css"];

  for (const file of requiredFiles) {
    if (!(await exists(path.join(pluginRoot, file)))) {
      throw new Error(`Missing ${file}. Run "npm run build" first.`);
    }
  }

  await mkdir(pluginDir, { recursive: true });
  await mkdir(path.join(sampleVaultRoot, "Imports", "ChatGPT"), { recursive: true });

  for (const file of requiredFiles) {
    await replaceWithSymlink(path.join(pluginRoot, file), path.join(pluginDir, file));
  }

  await ensurePluginEnabled();

  console.log(`Sample vault symlinked at ${sampleVaultRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
