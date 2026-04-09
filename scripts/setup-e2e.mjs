import { access, copyFile, cp, mkdir, rm, symlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const e2eRoot = pluginRoot;
const unpackedAppRoot = path.join(e2eRoot, ".obsidian-unpacked");
const e2eVaultRoot = path.join(e2eRoot, "e2e-vault");
const sampleVaultRoot = path.join(pluginRoot, "sample-vault");
const defaultObsidianAppPath = "/Applications/Obsidian.app";
const obsidianAppPath = process.env.OBSIDIAN_APP_PATH ?? defaultObsidianAppPath;

async function exists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureBuildArtifacts() {
  for (const fileName of ["main.js", "manifest.json", "styles.css"]) {
    if (!(await exists(path.join(pluginRoot, fileName)))) {
      throw new Error(`Missing ${fileName}. Run "npm run build" first.`);
    }
  }
}

async function ensureObsidianApp() {
  if (!(await exists(obsidianAppPath))) {
    throw new Error(`Obsidian app not found at ${obsidianAppPath}. Set OBSIDIAN_APP_PATH if needed.`);
  }
}

async function unpackObsidianApp() {
  const appAsarPath = path.join(obsidianAppPath, "Contents", "Resources", "app.asar");
  const obsidianAsarPath = path.join(obsidianAppPath, "Contents", "Resources", "obsidian.asar");

  await rm(unpackedAppRoot, { recursive: true, force: true });
  await mkdir(unpackedAppRoot, { recursive: true });
  await execFileAsync("npx", ["@electron/asar", "extract", appAsarPath, unpackedAppRoot], {
    cwd: pluginRoot,
  });
  await copyFile(obsidianAsarPath, path.join(unpackedAppRoot, "obsidian.asar"));
}

async function prepareSampleVault() {
  await execFileAsync("npm", ["run", "setup:sample-vault"], {
    cwd: pluginRoot,
  });

  const pluginDataPath = path.join(sampleVaultRoot, ".obsidian", "plugins", "chats2md", "data.json");

  if (!(await exists(pluginDataPath))) {
    throw new Error(`Expected sample vault plugin data at ${pluginDataPath}.`);
  }
  await rm(e2eVaultRoot, { recursive: true, force: true });
  await cp(sampleVaultRoot, e2eVaultRoot, {
    recursive: true,
    dereference: false,
    force: true,
  });

  const pluginDir = path.join(e2eVaultRoot, ".obsidian", "plugins", "chats2md");
  await mkdir(pluginDir, { recursive: true });
  for (const fileName of ["manifest.json", "main.js", "styles.css"]) {
    const targetPath = path.join(pluginDir, fileName);
    await rm(targetPath, { force: true });
    await symlink(path.join(pluginRoot, fileName), targetPath);
  }
}

async function main() {
  await ensureBuildArtifacts();
  await ensureObsidianApp();
  await unpackObsidianApp();
  await prepareSampleVault();
  console.log(`Prepared Obsidian E2E harness at ${unpackedAppRoot} with vault ${e2eVaultRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
