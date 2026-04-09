import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

function electronSupportDir() {
  return path.join(os.homedir(), "Library", "Application Support", "Electron");
}

export function electronObsidianConfigPath() {
  return path.join(electronSupportDir(), "obsidian.json");
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function ensureElectronVaultRegistered(vaultPath) {
  const configPath = electronObsidianConfigPath();
  await mkdir(path.dirname(configPath), { recursive: true });

  const config = (await readJsonIfExists(configPath)) ?? { vaults: {} };
  config.vaults ??= {};

  for (const [vaultId, entry] of Object.entries(config.vaults)) {
    if (entry && typeof entry === "object" && entry.path === vaultPath) {
      entry.ts = Date.now();
      entry.open = true;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      return vaultId;
    }
  }

  const vaultId = crypto.randomBytes(8).toString("hex");
  config.vaults[vaultId] = {
    path: vaultPath,
    ts: Date.now(),
    open: true,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return vaultId;
}

export async function readElectronVaultId(vaultPath) {
  const config = await readJsonIfExists(electronObsidianConfigPath());
  const vaults = config?.vaults;
  if (!vaults || typeof vaults !== "object") {
    return null;
  }

  for (const [vaultId, entry] of Object.entries(vaults)) {
    if (entry && typeof entry === "object" && entry.path === vaultPath) {
      return vaultId;
    }
  }

  return null;
}
