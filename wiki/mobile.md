# Mobile

The pilot is an Expo SDK 58 / React Native 0.88 application with Expo Router. It is a launchable shell, not a signed-in Companybot client yet.

## Structure and boundaries

- `apps/mobile/src/app`: route files and root navigation only. Put features in `src/features` and native UI in `src/components` as they are implemented.
- `apps/desktop`: existing Electron client, with its own UI and release lifecycle.
- `packages/core`: existing domain and agent logic. Mobile should use explicit browser-safe subpath exports, never the agent runtime barrel or server I/O modules.
- `packages/backend`: existing Convex deployment and generated client contracts. Clients may import generated API references and types; never import backend handlers.

Keep UI platform-specific. Extract shared client logic only when both clients use it. Server state belongs in Convex; transient screen state stays local. Mobile authentication must use secure native token storage and preserve the existing per-request workspace authorization before adding workspace features. No secrets belong in EXPO_PUBLIC variables.

## Development

Install from the repository root with `pnpm install --frozen-lockfile`. Run `pnpm dev:mobile` for Metro. From `apps/mobile`, use `pnpm ios` or `pnpm android` to generate and build native projects (Xcode or Android SDK required). SDK 58 is in the Expo Go transition period, so use a native development build if the installed Expo Go supports only SDK 57.

Native `ios/` and `android/` folders are generated and ignored. Change app.json and config plugins instead of editing generated code. Bundle identifiers are provisional `com.companybot.mobile`; confirm ownership before store registration. Signing, store submission, push credentials, EAS project registration and OTA publishing are not configured by this scaffold.

## Validation and upgrades

`pnpm typecheck` covers all workspaces. `pnpm test` covers existing domain/backend/desktop tests. `pnpm --filter @companybot/mobile export` bundles iOS, Android and web in CI; it does not prove a native build or device behavior. Native simulator and physical-device checks remain required before shipping.

Use `pnpm exec expo install <package>` from apps/mobile for native dependencies, followed by `pnpm exec expo install --check` and `pnpm dlx expo-doctor`. Keep React and React Native on the SDK-supported versions, even when desktop uses a newer React patch. Use one root lockfile and pnpm isolated workspaces; no Metro resolver overrides or extra task orchestrator are needed here. Review major dependency upgrades with typecheck, tests and desktop/mobile bundles.

## Sources

- [Expo monorepos](https://docs.expo.dev/guides/monorepos/) supports pnpm workspaces, apps/packages layout and automatic Metro configuration.
- [Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/) documents generated native projects and config plugins.
- [Expo Router](https://docs.expo.dev/router/introduction/) documents file-based routing and the SDK 58 transition.
