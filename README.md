# Chats2MD

`Chats2MD` is a desktop-only Obsidian plugin that syncs ChatGPT conversations into Markdown notes.

## Requirements and disclosures

- A ChatGPT account and a current session JSON payload are required.
- The plugin makes network requests to `https://chatgpt.com` for conversation-list fetches, conversation-detail fetches, account validation, and asset downloads.
- Session payloads are stored in Obsidian secret storage, not in plugin `data.json`.
- The session payload is expected to come from `https://chatgpt.com/api/auth/session`. The plugin reads it locally to extract the ChatGPT auth material it needs for requests to `chatgpt.com`, including `accessToken`, `account.id`, `user.id`, `user.email`, and optional cookie/header data.
- Session payloads are validated before save. Expired or otherwise unhealthy sessions are rejected instead of being stored.
- The plugin does not send that session payload to any service other than ChatGPT itself. It is used only for local validation, account identification inside the vault, and authenticated requests back to `chatgpt.com`.
- Deleting an account removes its metadata from plugin settings and clears the stored secret payload by overwriting it with an empty value. Obsidian 1.11.4 does not expose a secret-delete API.
- Optional JSON sidecars store raw ChatGPT conversation detail payloads as local vault files next to notes.
- Optional sync logs and sync reports are written into your vault.
- The plugin does not include telemetry, ads, remote configuration, or self-update behavior.
- The plugin is desktop-only. Long-running ChatGPT sync is out of scope on Android and iOS.

## What the plugin does

- Adds a `Sync all accounts` command.
- Adds a `Rebuild from JSON` command.
- Adds a `Sync conversations` ribbon action to open the sync flow.
- Adds a per-note `Force sync from ChatGPT` action for synced ChatGPT notes.

## Sync behavior

1. Configure one or more ChatGPT account sessions in plugin settings.
   The plugin expects the payload from `https://chatgpt.com/api/auth/session`, stores it in Obsidian secret storage, and derives the fields needed to authenticate ChatGPT API requests.
2. Start sync from the ribbon icon or command palette.
3. Choose whether to sync all configured accounts or a single account.
4. The plugin fetches the full conversation list for each selected account.
5. After fetching each account's conversation list, the plugin prompts you to sync:
   - the full discovered range,
   - a date range, or
   - the latest N conversations by `created_at`.
6. Conversation details are fetched one conversation at a time, with a randomized delay between requests.
7. Notes are created, updated, or moved to match the configured folder and path template.
8. Referenced assets are downloaded and linked into the generated Markdown.

Synced notes are authoritative outputs from ChatGPT data. Local edits to synced note content may be overwritten by later syncs, force sync, or rebuild-from-JSON runs.

## Storage layout

- Default sync folder: `Imports/ChatGPT`
- Default note path template: `{date}/{slug}`
- Advanced sync tuning settings are available in the plugin settings tab under a collapsed section at the end.
- The settings tab labels session management consistently as `account sessions`, and transient health-check results stay visible only while that settings pane remains open.
- Supported path placeholders:
  - `{date}`: conversation created date (`YYYY-MM-DD`)
  - `{slug}`: sanitized conversation title
  - `{email}`: ChatGPT account email
  - `{account_id}`: ChatGPT account ID
  - `{conversation_id}`: ChatGPT conversation ID
- Built-in path template presets:
  - `{date}/{slug}`
  - `{email}/{account_id}/{date}/{slug}`
  - `{email}/{account_id}/{slug}`
- Asset storage modes:
  - `Global by conversation`: `<sync-folder>/_assets/<account_id>/`
  - `With conversation folder`: `<conversation-folder>/_assets/`
- Optional JSON sidecar caching stores raw `/backend-api/conversation/{id}` payloads as `<note>.json`.
- Optional sync reports default to `<syncFolder>/sync-result/` and support the `<syncFolder>` placeholder.
- Sync logs are also stored in the configured sync report folder.
- The Sync report settings section includes cleanup actions to remove all generated sync reports/logs or prune the folder down to the latest 10 generated files.
- Advanced Sync Tuning currently exposes:
  - conversation-list parallel fetch count
  - conversation-list retry attempts
  - conversation-detail retry attempts
  - conversation-detail browse-delay min/max
  - pause threshold for consecutive ChatGPT `429` responses
  - default prefilled value for `Newest conversations` in the sync subset modal

## Rebuild from JSON

`Rebuild from JSON` rebuilds existing synced notes from cached local JSON sidecars without calling the ChatGPT conversation-detail endpoint.

In plugin settings, the related action is labeled `Rebuild Markdown from cached JSON`.

- Notes without a JSON sidecar are skipped.
- Asset references are re-resolved using the configured asset storage mode.
- Notes may be moved if the current path template resolves to a different location.

## Obsidian plugin development

Install dependencies and start the plugin build in watch mode:

```bash
npm install
npm run dev
```

Build a production bundle:

```bash
npm run build
```

Run code quality checks:

```bash
npm run lint
npm run build
npm run format:check
npm test
```

Auto-fix formatting and lint issues:

```bash
npm run format
npm run lint:fix
```

The build also creates an installable zip at `release/chats2md-<version>.zip`.

The zip contains:

- `chats2md/main.js`
- `chats2md/manifest.json`
- `chats2md/styles.css`

For community-plugin releases, publish a GitHub release and attach `main.js`, `manifest.json`, and `styles.css` as binary assets.
The full release and Obsidian submission checklist lives in [`docs/release.md`](docs/release.md).

## Sample vault

A runnable test vault lives under [`sample-vault/`](sample-vault/).

Build the plugin and copy the current bundle into the vault:

```bash
npm run build
npm run setup:sample-vault
```

`setup:sample-vault` symlinks `main.js`, `manifest.json`, and `styles.css` into the sample vault plugin directory so `npm run dev` updates are visible there without rerunning setup.

Then open `sample-vault` in Obsidian and enable the `Chats2MD` community plugin.

## E2E

There is a real Electron + Playwright smoke test under [`e2e/chats2md.spec.ts`](e2e/chats2md.spec.ts).

Initial setup:

```bash
npm run build
npm run e2e:bootstrap
```

`e2e:bootstrap` unpacks the local Obsidian app and opens the test vault once so you can disable restricted mode and enable community plugins if Obsidian prompts you.

After that, run:

```bash
npm run e2e
```

## Icon

The plugin icon asset is available at [`assets/chats2md-icon.svg`](assets/chats2md-icon.svg).
The ribbon icon in the plugin UI uses the same SVG.
