# Release Guide

This document covers the repeatable steps for publishing `Chats2MD` GitHub releases and submitting or updating the Obsidian community-plugin review.

`Chats2MD` should be released and reviewed as a desktop-only plugin. Android and iOS are out of scope because long-running ChatGPT sync is not supported there.

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

3. Confirm the README still matches the current settings UI labels, session-validation behavior, and security/storage disclosures.
4. Confirm `manifest.json.version` is the version you want to publish.
5. Confirm `manifest.json` still reflects desktop-only support with `isDesktopOnly: true`.
6. If `minAppVersion` changed, confirm `versions.json` includes the new mapping.
7. Create a Git tag that exactly matches `manifest.json.version`.
8. Push the tag:

```bash
git push origin <version>
```

9. Wait for the `Release` workflow to finish.
10. Verify the GitHub release contains:
- `main.js`
- `manifest.json`
- `styles.css`
- `release/chats2md-<version>.zip`
11. If this is the first release, confirm the repository description, topics, and homepage are set on GitHub.

## Re-releasing the same version

Use this flow when `manifest.json.version` stays the same but the published release needs to point at a newer commit.

1. Confirm `manifest.json.version` and `package.json.version` still equal the release version, for example `1.0.0`.
2. Re-run the local verification suite and rebuild the release assets.
3. Move the local tag to the target commit:

```bash
git tag -f 1.0.0
```

4. Replace the remote tag:

```bash
git push origin :refs/tags/1.0.0
git push origin 1.0.0
```

5. Wait for the `Release` workflow to run again for `1.0.0`.
6. Verify the refreshed GitHub release assets before announcing the re-release.

The workflow already handles an existing GitHub release named `1.0.0` by replacing the uploaded assets in place.

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
5. If the plugin is desktop-only, make that explicit in the PR body and leave Android/iOS unchecked as not applicable.

## Follow-up after first submission

- Keep the Playwright/Electron E2E flow manual until it is portable to GitHub-hosted runners.
- Consider BRAT distribution if you want external testers before marketplace approval.
- Add release-note generation only after the basic release path is stable.
