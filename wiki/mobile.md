# Mobile

The pilot is an Expo SDK 58 / React Native 0.88 application with Expo Router. The signed-in client includes chats, collaborative pages, databases and workspace settings. See [Mobile parity](mobile-parity.md) for implementation and acceptance status.

## Structure and boundaries

- `apps/mobile/src/app`: route files and root navigation only. Put features in `src/features` and native UI in `src/components` and shared controls in `src/components/ui`. `src/design` owns semantic tokens; native navigation helpers live in `src/components/navigation`.
- `apps/desktop`: existing Electron client, with its own UI and release lifecycle.
- `packages/core`: existing domain and agent logic. Mobile should use explicit browser-safe subpath exports, never the agent runtime barrel or server I/O modules.
- `packages/backend`: existing Convex deployment and generated client contracts. Clients may import generated API references and types; never import backend handlers.

Keep UI platform-specific. Extract shared client logic only when both clients use it. Server state belongs in Convex; transient screen state stays local. Mobile authentication must use secure native token storage and preserve the existing per-request workspace authorization before adding workspace features. No secrets belong in EXPO_PUBLIC variables.

## Development

Install from the repository root with `pnpm install --frozen-lockfile`. Run `pnpm dev --mobile` for the local Convex backend and Metro together, or `pnpm dev:mobile` for Metro against an already running backend. Set `EXPO_PUBLIC_CONVEX_URL` in `apps/mobile/.env.local` for a remote development backend; never put secrets in public environment variables. From `apps/mobile`, use `pnpm ios` or `pnpm android` to generate and build native projects (Xcode or Android SDK required). SDK 58 is in the Expo Go transition period, so use a native development build if the installed Expo Go supports only SDK 57.

When updating an existing local database across schema changes, run `pnpm exec convex run migrations:runAll` against that local deployment and check `migrations:status`. The retained migrations initialize custom roles and upgrade skills, wakeups and page data; clients must not seed partial replacements.

Native `ios/` and `android/` folders are generated and ignored. Change app.json and config plugins instead of editing generated code. Bundle identifiers are provisional `com.companybot.mobile`; confirm ownership before store registration. Signing, store submission, push credentials, EAS project registration and OTA publishing still require project configuration. Notification registration, authenticated routing, delivery retries and receipts are implemented, but remote push delivery is not verified until APNs/FCM credentials and `extra.eas.projectId` are configured.

## Validation and upgrades

`pnpm typecheck` covers all workspaces. `pnpm test` covers domain, backend, desktop and mobile tests. `pnpm --filter @companybot/mobile export` bundles iOS, Android and web in CI; it does not prove a native build or device behavior. Native simulator and physical-device checks remain required before shipping.

Use `pnpm exec expo install <package>` from apps/mobile for native dependencies, followed by `pnpm exec expo install --check` and `pnpm dlx expo-doctor`. Keep React and React Native on the SDK-supported versions, even when desktop uses a newer React patch. Use one root lockfile and pnpm isolated workspaces; no Metro resolver overrides or extra task orchestrator are needed here. The backend explicitly pins the React/React DOM development peers required by its collaboration component to the mobile SDK pair, so its generated-contract dependency does not introduce a second React into mobile autolinking. Desktop keeps its own supported renderer version. Review major dependency upgrades with typecheck, tests and desktop/mobile bundles.

## Sources

- [Expo monorepos](https://docs.expo.dev/guides/monorepos/) supports pnpm workspaces, apps/packages layout and automatic Metro configuration.
- [Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/) documents generated native projects and config plugins.
- [Expo Router](https://docs.expo.dev/router/introduction/) documents file-based routing and the SDK 58 transition.

## Native interaction policy

Prefer real platform controls over recreating their appearance. SDK 58 uses `expo-router/native-tabs` (the stable import), a native stack per tab, system search bars, and `Stack.Toolbar` buttons/menus. iOS receives SF Symbols and native glass treatments where supported; Android receives Material Symbols and system navigation behavior. Keep platform defaults for gestures and transitions.

`@expo/ui` supplies SwiftUI and Jetpack Compose controls behind shared component APIs: choice menus, sheets, dates and buttons. Settings uses a small shared React Native list library with native symbols and switches, following the local Stuff and HKT composition patterns. Simple confirmation decisions use native alerts; asynchronous destructive operations retain a sheet with busy locks and visible errors. Required choices cannot be cleared accidentally. Long lists and multiple selections use searchable sheets. React Native TextInput and Switch already render native controls; retain them where their editing and accessibility behavior fits.

The document editor is an intentional Expo DOM boundary: existing BlockNote/ProseMirror documents must keep their exact schema and collaboration protocol. Native callbacks expose only the selected page and validated operations; credentials stay outside the WebView. Navigation guards protect pending edits; native WebView teardown flushing remains best effort.

The editor and version previews use Expo's default DOM WebView on both native platforms. A tracked pnpm patch to Expo 58.0.23 handles its native `injectJavaScript` promise: the upstream wrapper assumes a void return, leaving late results unhandled after navigation removes the view. Prop updates wait for `DOM_READY`, when the DOM listener and native view exist; initial props still come from the embedded payload, and the readiness event replays the latest values. Callback results remain independent of prop readiness. A layout-effect cleanup marks the bridge detached during React’s removal commit, before passive callbacks can target the removed native view. The patch stops injections after unmount/ref detachment and suppresses only a missing-DomWebView rejection from an already detached view; live-view failures and unrelated exceptions remain visible. Keep the editor's save/navigation guards: bridge teardown handling does not guarantee a final save after removal. Reassess the patch when upgrading Expo.

All serializable editor props cross that boundary as one URI-encoded JSON payload (`domPayload.ts`); capability callbacks stay top-level. Encoding before injection preserves exact document/reference text across WebView serializers and prevents user text from becoming JavaScript interpolation; decoding happens only inside the DOM component. Regression tests exercise nested JSON, quotes, backticks, interpolation, slashes, newlines and Unicode, plus late native rejection handling. Credentials remain outside this payload.

Native document views use BlockNote’s single `bn-scroll-container`, which follows the visual viewport and keeps its mobile formatting toolbar outside the scrolling content. The DOM component updates Expo’s existing viewport meta tag with `interactive-widget=resizes-content` rather than adding a conflicting second tag; this change stays inside the native DOM boundary. See [BlockNote mobile compatibility](https://www.blocknotejs.org/docs/getting-started#mobile-compatibility) and [mobile formatting toolbar layout](https://www.blocknotejs.org/docs/react/components/formatting-toolbar). Software keyboard positioning and long-document scrolling still require device acceptance.

Research: [Expo UI](https://docs.expo.dev/versions/v58.0.0/sdk/ui/), [native tabs](https://docs.expo.dev/router/advanced/native-tabs/), [native toolbars](https://docs.expo.dev/router/advanced/stack-toolbar/), [native menus](https://docs.expo.dev/versions/v58.0.0/sdk/ui/drop-in-replacements/menu/), [native sheets](https://docs.expo.dev/versions/v58.0.0/sdk/ui/drop-in-replacements/bottomsheet/), and [date pickers](https://docs.expo.dev/versions/v58.0.0/sdk/ui/drop-in-replacements/datetimepicker/).
