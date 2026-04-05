# Chats2MD

`Chats2MD` is an Obsidian plugin that imports full ChatGPT conversation logs into
Markdown notes.

## Requirements and disclosures

- A ChatGPT account and valid session payload are required.
- The plugin uses the network to access `https://chatgpt.com` APIs for conversation
  list/detail fetches and asset downloads.
- Session payloads are stored in Obsidian Secret Storage instead of plugin `data.json`.
- The plugin does not include client-side telemetry, ads, or plugin self-update behavior.

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

This now also creates an installable zip at:
`release/chats2md-<version>.zip`

The zip contains `chats2md/main.js`, `chats2md/manifest.json`, and
`chats2md/styles.css` for manual installation.

For community-plugin updates, publish a GitHub release and attach these files as
binary assets: `main.js`, `manifest.json`, and `styles.css`.

The plugin adds a `Sync ChatGPT conversations` command and ribbon action.
Configure account session JSON payloads and default folder in plugin settings.
Session JSON payloads are stored in Obsidian Secret Storage, and each account entry shows its `user.id`,
`user.email`, and `account.id`. Start sync from the ribbon/command, choose all
accounts or one account, and the plugin will fetch full conversation logs and
upsert notes under a configurable path template (default `{date}/{slug}` with
presets like `{email}/{account_id}/{date}/{slug}`). Each full sync run also writes
a markdown report when enabled in settings. The default report folder is
`<syncFolder>/sync-result/` (supports `<syncFolder>` placeholder for custom
locations). Asset storage can be configured
as global (`<default-folder>/_assets/<account_id>/`) or local
to each conversation folder (`<conversation-folder>/_assets/`).
Optionally, you can enable JSON sidecar caching in settings to store raw
`/backend-api/conversation/{id}` payloads next to notes as `<note>.json`, and run
a manual settings action to rebuild markdown notes from cached JSON without
calling the conversation detail endpoint.

## Sample vault

A runnable test vault lives under [`sample-vault/`](sample-vault/).

Build the plugin and copy the current bundle into the vault:

```bash
npm run build
npm run setup:sample-vault
```

`setup:sample-vault` now symlinks `main.js`, `manifest.json`, and `styles.css`
into the sample vault plugin directory, so `npm run dev` updates are visible
there without rerunning setup.

Then open `sample-vault` in Obsidian and enable the `Chats2MD` community plugin.

## Icon

The plugin icon asset is available at [`assets/chats2md-icon.svg`](assets/chats2md-icon.svg).
The ribbon icon in the plugin UI uses the same SVG.
