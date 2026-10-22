# Releases

## Cut a release
```
pnpm release patch   # or minor, major, 1.2.3
pnpm release alpha   # or beta, 1.2.3-alpha.1
```
From a clean `main` that matches origin. It runs checks, deploys the prod backend, bumps `src/desktop/package.json`, tags `vX.Y.Z`, and pushes. `.github/workflows/release.yml` then builds, signs, notarizes, and publishes to GitHub Releases.

Alpha/beta versions publish as GitHub prereleases. Installs on a prerelease update to newer prereleases and stable versions; stable installs ignore prereleases. `patch` from a prerelease ships that version as stable (0.2.0-alpha.3 → 0.2.0).

The backend deploys before the app ships, so backend changes must keep the previous app version working.

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
