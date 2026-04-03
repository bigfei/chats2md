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

The plugin adds an `Import ChatGPT conversations` command and ribbon action.
Configure the session JSON, default folder, and default conversation limit in
the plugin settings, then use the ribbon or command to confirm and start an
import. The importer fetches the conversation list, downloads each full
conversation log, and upserts notes by `chatgpt_conversation_id`. The session
JSON must include `accessToken` and `account.id`; `cookie` is optional.

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
