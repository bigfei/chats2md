# Chats2MD

`Chats2MD` is an Obsidian plugin that imports full ChatGPT conversation logs into
markdown notes.

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

The plugin adds a `Sync ChatGPT conversations` command and ribbon action.
Configure account session JSON payloads and default folder in plugin settings.
Session JSON payloads are stored in Obsidian Secret Storage, and each account entry shows its `user.id`,
`user.email`, and `account.id`. Start sync from the ribbon/command, choose all
accounts or one account, and the plugin will fetch full conversation logs and
upsert notes under a configurable path template (default `{date}/{slug}` with
presets like `{email}/{user_id}/{date}/{slug}`). Each full sync run also writes
a markdown report to `<default-folder>/result/`.

## Sample vault

A runnable test vault lives under [`sample-vault/`](/Users/bigfei/Documents/dev/me/chats2md/sample-vault).

Build the plugin and copy the current bundle into the vault:

```bash
npm run build
npm run setup:sample-vault
```

`setup:sample-vault` now symlinks `main.js`, `manifest.json`, and `styles.css`
into the sample vault plugin directory, so `npm run dev` updates are visible
there without rerunning setup.

Then open `sample-vault` in Obsidian and enable the `Chats2MD` community plugin.

## Python helper

The original Python utility now lives under [`py/`](/Users/bigfei/Documents/dev/me/chats2md/py).

Run it from the repo root with:

```bash
uv --directory py run list-conversations ../session.json
```
