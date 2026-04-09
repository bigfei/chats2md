import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.join(pluginRoot, ".obsidian-unpacked", "main.js");
const vaultPath = process.env.OBSIDIAN_E2E_VAULT_PATH ?? path.join(pluginRoot, "sample-vault");

console.log("");
console.log("Obsidian E2E bootstrap");
console.log("----------------------");
console.log(`Vault: ${vaultPath}`);
console.log("");
console.log("When Obsidian opens:");
console.log("  1. Open the vault if Obsidian prompts you.");
console.log("  2. Disable restricted mode / enable community plugins if prompted.");
console.log("  3. Confirm the Chats2MD plugin is enabled.");
console.log("  4. Close Obsidian when the vault is ready.");
console.log("");

const child = spawn(
  "npx",
  ["electron", appPath, "open", `obsidian://open?path=${encodeURIComponent(vaultPath)}`],
  {
    cwd: pluginRoot,
    stdio: "inherit",
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
