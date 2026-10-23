---
name: release
description: Cut a Companybot desktop release end to end — write user-facing release notes, get them approved, run `pnpm release`, and watch the signed build publish to GitHub Releases. Use for /release or when asked to ship, cut, or publish a release.
---

# Release

Ships the desktop app: notes → approval → `pnpm release` (prod snapshot, backend deploy, migrations, version bump, tag) → CI builds, signs, notarizes, and publishes. Background: [wiki/releases.md](../../../wiki/releases.md).

The argument is the bump: `alpha`, `beta`, `patch`, `minor`, `major`, or an exact version. No argument: `alpha` while the version is below 1.0, otherwise ask.

## 1. Preflight
Stop and say why if any fails:
- On `main`, clean tree, in sync with `origin/main` (`git fetch origin main --tags`).
- Latest CI on `main` passed: `gh run list -w ci.yml -b main -L 1`.
- Nothing half-done: no open PRs the user said should go in (`gh pr list`). Mention any open ones.
- Next version: `node scripts/release.mjs <bump> --next`.

## 2. Gather what changed
- Last published release: `gh release list -L 1` (tags whose build failed have no release; skip them).
- Merged PRs since then: `git log <last-tag>..origin/main --merges --oneline` and `gh pr list --state merged --base main -L 50 --json number,title,body,mergedAt` filtered to after that release.
- First release ever: everything on `main`.
- Read PR bodies and, when a title is unclear, the diff. Notes must be true.

## 3. Write the notes
Markdown for the people using the app, not developers. Save to a temp file (`mktemp /tmp/release-notes.XXXX.md`).

```
## What's new
- **Connect Night Owl.** Agents can look up your leads and show them in a table. (#1)

## Fixes
- Long tables no longer scroll inside the message; they show 10 rows with "Show all". (#3)
```

Rules:
- Lead with what someone can now do or will notice. One line each, bold the feature.
- End each bullet with its sources in parentheses: PR numbers (`#12`), or short commit SHAs (`5530e2e`) for work merged without a PR. GitHub turns both into links with previews.
- Plain words. No file names, refactors, CI, tests, or dependency bumps (GitHub's PR list below the notes covers those).
- Group as **What's new**, **Improvements**, **Fixes**. Omit empty groups.
- Usually 2–8 bullets. If nothing user-facing changed, say so in one line ("Behind-the-scenes improvements.").
- Prereleases: add a first line `Alpha build — expect rough edges.` (or Beta).
- Never mention internal-only items listed under "Before launch" in wiki/architecture.md as features (e.g. the Night Owl test plugin) unless the user says to.

## 4. Get approval
Show the version and the notes in chat. Wait for the user's OK or edits. Skip this only if they already said to ship without review.

## 5. Release
```
pnpm release <bump> --notes <temp file>
```
It runs typecheck and tests, snapshots prod to `backups/`, deploys the prod Convex backend, runs pending migrations, commits the version bump and `release-notes/v<version>.md`, tags, and pushes. If it fails before deploying, nothing changed: fix the cause and rerun. If a migration fails, the new backend is already live on prod but nothing is tagged or published: fix and rerun, or restore the snapshot it names (`npx convex import --prod --replace-all <file>`) after checking with the user.

## 6. Watch the build
- `gh run list -w release.yml -L 1`, then `gh run watch <id>` in the background (takes ~10–15 min; notarization is the slow part).
- Success: `gh release view v<version>` — report the release URL and the `.dmg` name.
- Failure: `gh run view <id> --log-failed`, find the cause, fix it on a branch → PR → merge, then cut the next version (a tag's workflow can't pick up fixes). Don't delete failed tags.

## 7. Report
One short message: version, link, what's in it, anything that needs the user.
