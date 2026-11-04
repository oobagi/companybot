# Mobile parity

The mobile client follows the Electron product model: workspaces contain chats, pages, databases and settings. Phone navigation uses those four destinations with pushed detail screens. Workspace selection stays per device. Native screens share a small semantic token library and reusable controls; UI is not imported from Electron.

## Implementation and acceptance

This is a working checklist, not a claim that every feature is complete. A feature is complete only when its normal, empty, loading, error, permission and archived states work.

- [ ] Design foundation: semantic light/dark colors, spacing, typography, radii, accessible controls, keyboard/safe-area containers.
- [ ] Session: email-code sign-in, secure token persistence, onboarding, workspace selection, invitations, sign-out and erased-account handling.
- [ ] Chat: channels, direct/group messages, threads, live replies, unread state, composer, attachments, mentions, reactions, edits, deletion, approvals and stopped turns.
- [ ] Documents: nested pages, rename/move/archive, compatible collaborative rich text, images, page links, history and restoration.
- [ ] Databases: records, fields, filtering, saved views, board layout, record bodies, linked records, discussion and undo.
- [ ] Settings: account/workspace preferences, members, permissions, agents, skills, automations, connectors, memory, activity, usage and Archive.
- [ ] Platform: safe deep links, foreground lifecycle, notification behavior, device testing and release configuration.
- [ ] Independent reviews: authorization/lifecycle, UX/accessibility, reusable architecture and performance.

## Decisions

- Follow Expo SDK 58's supported React/React Native versions and Expo Router native stacks and stable native tabs. Use protected routes for session navigation and server authorization for access control.
- Keep Convex as the server-state layer. Typed mobile hooks inject the selected workspace into every normal public request. Workspace changes remount feature state.
- Native auth tokens use SecureStore. Browser storage is isolated behind a platform adapter. Reuse the existing email-code provider.
- Use native lists and controls, with system typography and desktop's neutral surfaces and blue link accent. Custom targets use 48 points; native iOS controls keep system sizing of at least 44 points. Text can scale.
- Preserve BlockNote/ProseMirror's exact document schema and versioned collaboration protocol inside an isolated Expo DOM component. A plain text or Markdown replacement is not compatible.
- Keep auth credentials in the native runtime; editor callbacks expose only specific document operations. Reuse existing authenticated upload endpoints and discard abandoned uploads.
- Start with virtualized React Native lists; add specialized libraries where requirements justify them. Avoid a second UI or server-state framework.
- Native projects remain generated through Continuous Native Generation. Bundle export is not simulator or device validation.

## Research

- [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/)
- [Protected routes](https://docs.expo.dev/router/advanced/protected/) and [native tabs](https://docs.expo.dev/router/advanced/native-tabs/)
- [Convex Auth React Native storage](https://labs.convex.dev/auth/api_reference/react) and [SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/)
- [Keyboard handling](https://docs.expo.dev/guides/keyboard-handling/) and [safe areas](https://docs.expo.dev/develop/user-interface/safe-areas/)
- [React Native accessibility](https://reactnative.dev/docs/accessibility)
- [Expo DOM components](https://docs.expo.dev/guides/dom-components/) and [rich-text guidance](https://docs.expo.dev/guides/editing-richtext/)
- [DocumentPicker](https://docs.expo.dev/versions/v58.0.0/sdk/document-picker/) and [FileSystem](https://docs.expo.dev/versions/v58.0.0/sdk/filesystem/)
- [Monorepos](https://docs.expo.dev/guides/monorepos/)

## Native UI refinement

The shared design system comes before feature presentation. Native tabs own the bottom navigation, each tab owns a native navigation stack, and system search/creation/overflow controls replace content-level button rows. Native menus handle short single choices and chat actions; date fields use platform calendars. Native sheets keep gesture, keyboard and busy dismissal behavior centralized. App and navigation colors both follow system appearance.

Implementation is under device verification. Typecheck/lint/unit tests alone do not establish native layout quality, keyboard behavior, accessibility or notification delivery.

## Local verification — 2026-11-04

iPhone 18 Pro Max / iOS 27 simulator: checked native conversation toolbar menu, corrected message metadata alignment, compact composer and its native Add menu, SwiftUI Settings with native icons and safe-area placement, centered Pages empty state, and the content-sized New page sheet. Entered a temporary page title: Close presented native discard confirmation, Cancel retained the draft, and Discard closed it without creating a page.

Repository-wide typecheck and mobile lint pass. All platform/DOM bundles export. The merged suites passed 75 mobile, 319 core, 110 desktop and 719 backend tests; all 26 backend scale tests pass. After adding atomic role-update guards, 46 targeted backend tests and typecheck pass again. After extracting the browser-safe follow-up formatter, all 10 wakeup tests pass again. The desktop production bundle also builds. Android ARM64 debug build and installation pass on the Pixel 10 Pro emulator (API 37.1); the sign-in screen rendered with no initial native or JavaScript crash. Authenticated Android tabs, Settings, menus, edit/discard sheets, Usage month selection, board movement, saved items and database ordering were subsequently exercised successfully. These checks do not establish complete feature parity, remote push delivery, store readiness, or every screen/keyboard configuration.

Reference implementations inspected locally: Hunter King Theory (`header-menu`, `fullscreen-scroll-view`, `tab-screen`, design tokens) and Stuff (`Screen`, `List`, `ProfileEditorForm`, settings navigation). Official guidance: [Expo native toolbars](https://docs.expo.dev/router/advanced/stack-toolbar/), [stack scroll-edge effects](https://docs.expo.dev/router/advanced/stack/), [Apple entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data), and [Apple sheets](https://developer.apple.com/design/human-interface-guidelines/sheets).

## Integration with current desktop contracts

Mobile consumes `me.access` and server-provided posting/editing/manage flags. Channel, page and database access lists use the shared roles with View/Edit (Post for channels), explicit Save and stale-draft protection. Members and connectors preserve arbitrary role IDs; their replacement mutations accept an optional expected role set to reject concurrent revocations atomically. Private agent replies explain their visibility and require confirmation before explicit sharing. Workspace reset preserves the selected workspace while waiting.

Existing local data was upgraded through retained migrations, all reporting success. Native Settings and role-management sheets were inspected on the merged iOS app. These checks do not replace restricted-role, multi-device or physical-device acceptance.

Saved channel, database, page-sibling and view order is consumed from shared arrangements; All records follows the shared display and columns. Mobile now exposes shared ordering controls, personal pins/recent items and swipeable board columns. Android ordering, pin navigation and record movement have been exercised. Remote notification delivery, restricted-role device flows, complete keyboard/Dynamic Type coverage and physical devices still need acceptance testing.

The subsequent personal-skill private-reply update from main also passes repository-wide typecheck, 98 affected backend tests and 3 core skill tests.

## Component library before screen composition

The reusable library now has a development gallery (`More → Components`) with lists, forms, choices, typography, toolbars and feedback states. `GroupedList` owns native sections and rows; `ContentToolbar` owns editing controls; choice and date controls use deliberate native presentations. The [component contract](../apps/mobile/src/design/components.md) records ownership and composition rules. Settings uses the shared grouped-list adapter; duplicate iOS/Android renderers were removed. Documents now compose a bounded editor and the shared native bottom toolbar, with page actions in the navigation menu. Remaining feature screens still need composition and visual review against the library.

Android gallery verification covers all eight examples, light/dark appearance and interactions. iOS gallery verification covers normal/large-text grouped lists, native choices and dates, bottom toolbar and centered feedback. This pass found and fixed picker measurement, large-text row layout, and status-bar appearance restoration centrally. Settings navigation and document toolbar actions pass on both simulators. The iOS document check exposed missing nested BlockNote stylesheet imports; explicit core/react imports restored paragraph spacing and placeholder styling. The final mobile suite passes 106 tests across 19 files; mobile typecheck, lint and all-platform/DOM export pass.

Document touch actions preserve the existing schema and collaboration boundary. Child creation was exercised on iOS, with its single server-created link present in the parent. Mounted BlockNote regressions cover nested deletion and movement without unintended archiving. A development-only stale DomWebView tag warning occurred during concurrent FastRefresh edits; the final Android navigation/toolbar smoke produced no new runtime errors. A stable release build and physical-device teardown still need acceptance testing.
