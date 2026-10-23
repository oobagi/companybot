# Releases

## Cut a release
Run **`/release`** (or `/release beta`, `/release patch`…) in Claude Code. The skill (`.claude/skills/release/SKILL.md`) writes user-facing notes from what was merged, asks you to approve them, releases, and watches the build.

Under the hood:
```
pnpm release patch   # or minor, major, 1.2.3
pnpm release alpha   # or beta, 1.2.3-alpha.1
```
Add `--notes file.md` to publish notes (committed as `release-notes/v<version>.md`, shown above GitHub's PR list); `--next` prints the version a bump would make.

From a clean `main` that matches origin. It runs checks, snapshots prod, deploys the prod backend, runs pending migrations, bumps `src/desktop/package.json`, tags `vX.Y.Z`, and pushes. `.github/workflows/release.yml` then builds, signs, notarizes, and publishes to GitHub Releases.

Alpha/beta versions publish as GitHub prereleases. Installs on a prerelease update to newer prereleases and stable versions; stable installs ignore prereleases. `patch` from a prerelease ships that version as stable (0.2.0-alpha.3 → 0.2.0).

The backend deploys before the app ships, and installed apps update within hours, so backend changes must keep the previous app version working:
- **Add, don't remove.** New tables and optional fields are safe. To replace a public function, keep the old one working on top of the new data and delete it once installs have updated.
- **Data moves are migrations.** Deploying never changes existing rows. To change stored data, add a migration to `convex/migrations.ts` (Convex's migrations component). `pnpm release` runs every pending one on prod right after deploying and waits for them; the component remembers which finished, so each runs once. Run them on dev with `npx convex run migrations:runAll`.

## Snapshots
`pnpm release` saves a full export of prod to `backups/` (gitignored) before deploying. To undo a bad deploy or migration: `npx convex import --prod --replace-all backups/<file>.zip`. That replaces all prod data, so take a fresh export first. Scheduled backups in the Convex dashboard need the Pro plan; the free plan keeps up to 2 manual backups.

## In-app updates
The installed app checks GitHub Releases on launch and every 4 hours, downloads in the background, and shows **Update ready · Restart** in the sidebar. Settings → General → App has "Check for updates". macOS only updates signed, notarized apps.

## One-time setup: repo secrets
Same Apple Developer account as yap. Set them in companybot with `gh secret set NAME -R oobagi/companybot`:
- `CSC_LINK` — base64 of the Developer ID Application `.p12`
- `CSC_KEY_PASSWORD` — the `.p12` password
- `APPLE_API_KEY` — contents of the App Store Connect `AuthKey_XXXX.p8`
- `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`

## Build locally
`pnpm package:desktop` (signs with your keychain's Developer ID if present). Output: `src/desktop/release/`.

## Not done yet
App icon (uses Electron's default), Windows builds.
