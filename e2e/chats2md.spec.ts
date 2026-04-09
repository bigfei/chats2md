import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import path from "node:path";
import { ensureElectronVaultRegistered } from "../scripts/e2e-vault-registry.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const appPath = path.join(pluginRoot, ".obsidian-unpacked", "main.js");
const runVaultPath = process.env.OBSIDIAN_E2E_VAULT_PATH ?? path.join(pluginRoot, "sample-vault");

let app: ElectronApplication | null = null;
let page: Page | null = null;

async function launchObsidian(vaultToOpen: string) {
  const vaultId = await ensureElectronVaultRegistered(vaultToOpen);
  const launchedApp = await electron.launch({
    args: [appPath, "open", `obsidian://open?vault=${vaultId}`],
  });
  let launchedPage: Page | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const windows = launchedApp.windows();
    if (windows.length > 0) {
      launchedPage = windows[0]!;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!launchedPage) {
    throw new Error(
      "Timed out waiting for the first Obsidian window. Run `npm run e2e:bootstrap` once to trust the vault and enable community plugins.",
    );
  }

  await expect(launchedPage.locator(".workspace")).toBeVisible();
  await expect(launchedPage.getByLabel("Open command palette", { exact: true })).toBeVisible();
  return {
    launchedApp,
    launchedPage,
  };
}

test.beforeEach(async ({ browserName: _browserName }) => {
  const launched = await launchObsidian(runVaultPath);
  app = launched.launchedApp;
  page = launched.launchedPage;
});

test.afterEach(async () => {
  await app?.close();
  app = null;
  page = null;
});

test("plugin ribbon opens the sync modal in a real Obsidian app", async () => {
  await page!.getByLabel("Sync ChatGPT conversations", { exact: true }).click();
  await expect(page!.getByText("Configured accounts: 5 (5 enabled)")).toBeVisible();
  await expect(page!.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  await expect(
    page!.getByText("Mode: full conversation discovery. Results are ordered locally by conversation date, newest first."),
  ).toBeVisible();
});
