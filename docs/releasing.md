# Releasing Chats2MD

This document covers the repeatable steps for publishing `Chats2MD` GitHub releases and submitting or updating the Obsidian community-plugin review.

## Before you start

- Keep `sample-vault/` unchanged.
- Do not use broad `git add .` while ignored local vault artifacts with exported content still exist under the repo root.
- Ensure disposable local directories such as `e2e-vault/`, `.e2e/`, and `.obsidian-unpacked/` are either absent or still ignored.
- Confirm the repository is public before opening the Obsidian submission PR.

## Release checklist

1. Merge release-ready code to `main`.
2. Run the local verification suite:

```bash
gitleaks git
npm ci
npm run format:check
npm run lint
npm test
npm run build
```

3. Confirm `manifest.json.version` is the version you want to publish.
4. If `minAppVersion` changed, confirm `versions.json` includes the new mapping.
5. Create a Git tag that exactly matches `manifest.json.version`.
6. Push the tag:

```bash
git push origin <version>
```

7. Wait for the `Release` workflow to finish.
8. Verify the GitHub release contains:
   - `main.js`
   - `manifest.json`
   - `styles.css`
   - `release/chats2md-<version>.zip`
9. If this is the first release, confirm the repository description, topics, and homepage are set on GitHub.

## How the automation works

- `.github/workflows/ci.yml` runs on pushes to `main`, pull requests, and manual dispatch.
- CI scans tracked Git history for secrets with Gitleaks, then runs format checks, lint, tests, and `npm run build`.
- `.github/workflows/release.yml` runs on tag pushes matching `*.*.*`.
- The release workflow fails if the pushed tag does not equal `manifest.json.version`.
- The release workflow publishes the three Obsidian plugin assets individually plus the installable zip.

## Obsidian community-plugin submission

When the repository is public and the release assets are live:

1. Fork `obsidianmd/obsidian-releases`.
2. Add a new `community-plugins.json` entry with:
   - `id`: `chats2md`
   - `name`: `Chats2MD`
   - `author`: `bigfei`
   - `description`: `Sync full ChatGPT conversation logs into Markdown notes.`
   - `repo`: `bigfei/chats2md`
3. Open the submission PR.
4. If review feedback requires plugin changes, update the GitHub release assets for the same version only when appropriate; otherwise cut a new version and update the submission accordingly.

## Follow-up after first submission

- Keep the Playwright/Electron E2E flow manual until it is portable to GitHub-hosted runners.
- Consider BRAT distribution if you want external testers before marketplace approval.
- Add release-note generation only after the basic release path is stable.
