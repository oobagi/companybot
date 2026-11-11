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

Saved channel, database, page-sibling and view order is consumed from shared arrangements. The first ordered saved view opens by default; All is an ordinary view. Device overrides are scoped to each saved view and retain their shared base version until explicitly reset. Mobile now exposes shared ordering controls, personal pins/recent items and swipeable board columns. Android ordering, pin navigation and record movement have been exercised. Remote notification delivery, restricted-role device flows, complete keyboard/Dynamic Type coverage and physical devices still need acceptance testing.

The subsequent personal-skill private-reply update from main also passes repository-wide typecheck, 98 affected backend tests and 3 core skill tests.

## Component library before screen composition

The reusable library now has a development gallery (`More → Components`) with lists, forms, choices, typography, toolbars and feedback states. `SettingsList` owns custom flex rows and groups; `ContentToolbar` owns editing controls; choice and date controls use deliberate native presentations. The [component contract](../apps/mobile/src/design/components.md) records ownership and composition rules. Settings uses the shared custom list; the native grouped-list implementations were removed. Documents now compose a bounded editor and the shared native bottom toolbar, with page actions in the navigation menu. Remaining feature screens still need composition and visual review against the library.

Android gallery verification covers all eight examples, light/dark appearance and interactions. iOS gallery verification covers normal/large-text grouped lists, native choices and dates, bottom toolbar and centered feedback. This pass found and fixed picker measurement, large-text row layout, and status-bar appearance restoration centrally. Settings navigation and document toolbar actions pass on both simulators. The iOS document check exposed missing nested BlockNote stylesheet imports; explicit core/react imports restored paragraph spacing and placeholder styling. The final mobile suite passes 106 tests across 19 files; mobile typecheck, lint and all-platform/DOM export pass.

Document touch actions preserve the existing schema and collaboration boundary. Child creation was exercised on iOS, with its single server-created link present in the parent. Mounted BlockNote regressions cover nested deletion and movement without unintended archiving. Subsequent checks reproduced missing-DomWebView errors during normal navigation, so the earlier FastRefresh-only explanation was incorrect. WebView lifecycle handling remains under investigation; a stable release build and physical-device teardown still need acceptance testing.

## Reliability follow-up

The current-main integration passes repository typecheck, 331 core, 800 backend, 119 desktop and 128 mobile tests, plus 41 backend scale tests. These checks establish contract compatibility, not visual or device acceptance.

A real editor regression reproduced the typing/paste crash: the page-removal guard tried to convert new blocks before BlockNote assigned their IDs. The guard now inspects transaction identities while preserving page-deletion confirmation. The updated mobile suite passes 130 tests; typecheck and lint pass. On the iOS simulator, entering a new paragraph, navigating back and reopening preserved the paragraph without that crash. Android verification remains outstanding.

Mobile chat now consumes paginated history, bounds deep-link seeking with an explicit continuation, and uses publication time consistently. Review also corrected a race where a linked message could load before its list mounted and never scroll into view. Native long-history scrolling still needs acceptance testing.

The immediate priority is shared component reliability and on-device screen composition. Further feature expansion waits on validating navigation, lists, sheets, forms and feedback states together.

## Settings composition and reliability — 2026-11-05

Members and Memory now use native header actions and shared list rows with separate native menus. Permissions displays readable action summaries; tapping one opens its controls deliberately in a sheet. Existing authorization, version checks, destructive confirmations and permission semantics remain. Profile editing now permits an empty display name, matching the backend, and both profile/workspace editors protect dismissal while picture uploads or removal run.

Direct iOS simulator captures verify the Settings root, Members header/list, Memory's centered empty state, and Permissions at normal and accessibility-large text sizes. A cold-start comparison ruled out a suspected `ListRow` sizing change; its layout implementation was retained. Memory rows retain native text selection through the shared row component. The component gallery now includes adjacent long rows without extra spacing between them. Live-refresh screenshots showed transient overlapping rows and missing search chrome, so final layout checks used cold launches.

The document bridge now waits for the DOM readiness signal before prop updates and handles asynchronous injection failures after detachment. Native document layout follows BlockNote's viewport/scroll-container guidance. A fresh iOS document mount displayed persisted text with no WebView startup error or viewport warning. Repeated Back/history teardown and software-keyboard acceptance are still outstanding: the Maestro XCTest runner crashed before establishing its connection during this pass. Screenshots and code checks do not establish those interactions.

Mobile typecheck, lint and all 130 tests pass. iOS, Android, web and DOM export pass. Android device acceptance of these changes, upload error/dismissal interaction checks and full feature parity remain incomplete.

## Directory and form follow-up — 2026-11-05

Agents and Skills compose the shared native header/search and virtualized directory recipe. Agent summaries show their description; model and version details stay in the editor. Agent picture operations now lock editing and dismissal, and skill submissions use the shared domain validator before writing. Skill and automation drafts retain a captured baseline when remote data changes.

Automations now opens a read-only grouped detail with native navigation and actions. Configuration, agent, audience and webhook controls open deliberately; one task lock covers the detail and its sheets. Date filters reuse the native date control, including optional start/end bounds. Shared database views normalize against live fields before querying, so archiving a filter/sort field no longer breaks the selected view; the original version remains the save-conflict baseline. A regression test covers that archival transition.

iOS native automation verified Agents search, its centered no-results state, clearing search, opening New Agent, entering a draft and discarding through the native confirmation without creating an agent. The content-sized sheet and list were inspected after presentation settled. Isolated Maestro session storage restored iOS interaction testing. Android rendered Settings and exposed the new Agents header/list in its hierarchy, but the emulator later terminated with exit 137; this is not Android acceptance of the changes. Mobile typecheck, lint, all 131 tests and iOS/Android/web/DOM export pass. Independent source review found no introduced blockers.

Remaining work includes native automation-detail/date-filter interactions, upload failure/dismissal checks, document keyboard/teardown and long-history chat checks, connector detail composition, and pending-message presentation. An already-open view-options draft can still receive backend validation errors if its fields are archived remotely; closing and reopening refreshes that draft. Full parity and release readiness remain unverified.

## Native sheets and operation recovery — 2026-11-05

Connectors now follows the native searchable directory and read-only grouped-detail recipes. Connection credentials and role edits open deliberately in shared sheets; native header menus own removal/disconnection. Permission checks, arbitrary role IDs and role-update conflict checks remain intact. The local catalog is empty, so iOS verification covers its native search and centered empty state; populated detail, credential, role and OAuth interactions remain unverified.

Chat has a reusable pending-message row demonstrated in the component gallery. The optimistic row is scoped to its workspace, chat and thread, stays after committed messages even with device clock skew, and is replaced by Convex's committed result or rolled back on failure. Draft text and attachments remain persisted until acknowledgement; a shared draft lock prevents a second mounted composer from resending them. Unit tests cover failure/retry, navigation scope, replacement drafts and incomplete uploads. Actual delayed-send/failure interactions still need device acceptance. Process death after server commit but before local draft clearing remains an existing idempotency limitation.

Busy operations register synchronously with the workspace navigation guard. Document image uploads remain protected through the DOM insertion acknowledgement, with regression coverage for duplicate requests, read-only insertion and insertion failure. Open view-options drafts now identify remotely removed fields and offer deliberate cleanup before Apply/Save, retaining their original conflict baseline.

Page history now uses the shared native sheet and resolves child-page titles. iOS simulator checks exercised opening a document, Back/reopen, opening history, inspecting a version, closing the sheet and returning to Pages. Screenshots verify version text, child titles and the corrected native compact picker label. Maestro could not reliably assert DOM text inside the SwiftUI sheet; a semantic Close tap also required a coordinate retry. These checks therefore do not certify every sheet interaction. No new missing-DomWebView warning appeared during those cycles; software-keyboard and physical-device teardown remain open.

The Sending gallery example passes native menu navigation and renders text/attachment-only rows on iOS. Mobile typecheck, lint, all 141 tests across 27 files, and iOS/Android/web/DOM export pass. Independent source review found no introduced blocker after the lifecycle fixes. Android acceptance, populated connector/automation flows, upload failure/dismissal interactions, chat history and complete keyboard/accessibility coverage remain open. Full parity and release readiness remain incomplete.

## Foundation repair checkpoint (2026-11-05)

The custom SettingsList/SettingsGroup/SettingsRow library now replaces the native grouped-list renderers, following the local Stuff flat-list composition. Settings, Preferences, General, connector and automation details, and record properties share the same transparent flex rows, readable typography, native symbols and switches. Independent review confirmed the migration retains navigation, permission gates, consent, subscription and sign-out guards.

The profile editor now uses Cancel/Done sheet actions, separate picture editing, and a width-constrained SwiftUI choice label that wraps at accessibility sizes. The editor imports its required styles directly, shows initial loading/failure/retry state, gates native toolbar actions on readiness, and avoids double-scaling Android document text. Chat uses reusable message input and compact disclosures for attachments and activity. These repairs are local implementation progress, not complete editor acceptance.

Validation for this checkpoint: 152 mobile tests, mobile typecheck/lint and iOS/Android/web/DOM exports pass. iPhone gallery normal/accessibility-large text, profile selection/discard, light/dark Settings, Settings→General navigation and scrolling to Sign out were inspected. Android Settings→General navigation and scrolling to Sign out passed after a cold reload; screenshots show the current custom library. Earlier in this pass Android document typing/save/reopen and selection passed, with native font scaling and a keyboard-open dark-mode check.

Remaining: finish image insertion/save/reopen and formatting verification, validate iOS controlled editor persistence without simultaneous user input, handle already-ready WebView process loss, resolve long native button labels, complete the cross-platform large-text/keyboard/error matrix, and then continue the Electron parity checklist. The first Android navigation test sent a deep link during cold startup and landed on Chats; warm navigation passed. Cold-start link preservation remains an explicit routing follow-up.


## Desktop alignment and main integration (2026-11-10)

The branch incorporates main through `5f753f98`. The shared mobile library now uses desktop's neutral actions, blue links, Phosphor content icons, restrained borders, consistent 20-point screen gutters and a single 17/15/13-point text hierarchy. Custom Settings rows share their layout with directory rows; excessive grouped surfaces and heavy row labels are removed. Chats groups channels and direct messages without repeated descriptions. Page/database directories and explicit Cancel/Create sheets use the same foundation. Native navigation, tabs, menus and sheet controls remain platform-owned.

Integration repairs cover real saved database views and per-view device overrides, legacy pin ordering migrated into the shared rail, folder navigation without mounting a document editor, record links inside document content, and the desktop BlockNote 0.57 API changes. The Expo ESLint parser is resolved from its supported TypeScript installation so import checks actually run. Failed local backend startup now stops its owned process group.

Local validation: all workspace typechecks, desktop/mobile lint, 159 mobile tests, 384 core tests, 899 backend tests and 200 desktop tests pass. Mobile iOS/Android/web/DOM exports and the desktop web production build pass. Independent integration review found no new blocking issues in the changed lists, Settings, folder branching or creation guards.

The iPhone 18 Pro Max simulator was inspected in light appearance and accessibility-medium dark appearance for Chats and Settings. Profile editing remains readable with the keyboard open. Creating a QA page, typing a paragraph, navigating Back and reopening preserved its text. The first editor development bundle took 31 seconds and exceeded the previous 15-second startup timer; development now allows 60 seconds while packaged builds retain 15 seconds. This does not certify production startup reliability. Android rendered sign-in; authenticated QA stopped after device automation failures. No physical-device acceptance was performed.

Remaining priorities: finish editor image/formatting and process-loss acceptance, validate authenticated Android and the full keyboard/large-text matrix, review remaining feature-screen compositions, and port newer desktop capabilities. Mobile folder contents still omit uploaded Drive files. This is a foundation checkpoint, not complete Electron parity or release readiness.

## Native editor and upload recovery (2026-11-11)

Documents now use the shared floating toolbar with native formatting, insertion and block menus. These expose paragraph/headings/lists, inline styles, alignment, link editing and block movement without a second web formatting bar. Native link sheets preserve selection through collaboration, protect drafts and normalize bare website addresses. Native process loss disables controls and requires deliberate recovery, with confirmation for pending work; stale commands cannot replay on remount.

iPhone image insertion exposed a real failure: Expo File slicing creates an ArrayBuffer-backed Blob that React Native rejects. Shared bounded file-header validation now fixes both document and Settings image uploads. Photo library and file selection are separate explicit insertion actions. New Message uses Cancel/Start sheet actions, a virtualized recipient list and centered loading/empty feedback. Android menu accessibility activation and disabled-button contrast are repaired centrally.

Local validation: all 196 mobile tests across 38 files, mobile typecheck/lint and iOS/Android/web/DOM exports pass. Independent reviews covered editor lifecycle, selection mapping, stale commands, image validation and link handling. Mounted tests cover process termination, cancellation/confirmation of recovery and stale callbacks; they do not establish real device memory-pressure recovery.

iPhone 18 Pro Max simulator: native formatting menus, bold typing, heading changes, photo-library selection, successful image insertion, Back/reopen with persisted image and text, and opening/cancelling the native link sheet. New Message search shows centered no-results feedback above the keyboard with Start disabled. Pixel 10 Pro emulator: authenticated navigation, opening the document and image saved on iPhone, changing its heading to a paragraph through the native menu, and Back/reopen with the change preserved. Screenshots were inspected on both platforms.

Remaining: native link submission and actual process-loss device acceptance; complete keyboard, long-document, large-text, appearance and screen-reader coverage; native text-color and file-caption/replacement controls; remaining screen composition and newer desktop capabilities including uploaded Drive files. No physical-device or remote-push acceptance was performed. The UI foundation and full parity goal remain open.

## Screen composition and deliberate forms (2026-11-11)

Conversation details and Archive use the shared content gutter. Profile opens at its content size, and Add members uses a bounded virtualized list with centered feedback. Usage removes redundant cards and empty breakdowns, uses readable service names and scalable value rows, and centers its zero-usage state. A single Period row opens an explicit Cancel/Done sheet; changes stay local until committed.

Database, field, access, sub-page, view and filter editors keep their commit action in the sheet header. Field save includes a typed option even when Add option was not pressed, using the shared validator and preserving drafts on failure. Filter rows display readable conditions, option labels, dates and currency amounts; removal uses a separate native menu. Version checks, shared-versus-device view semantics, permission gates and draft guards remain intact. Native documents also suppress BlockNote's redundant web link popover after a successful native link edit.

iPhone acceptance: bare-domain link insertion, saved link after Back/reopen, database creation through Create, choice-field creation through Add with an unsubmitted option verified in the local backend, filter Done/Apply and reopening its readable summary, and access edit/Cancel/Discard without changing permissions. Usage was visually inspected on iOS and Android. Android additionally exercised Period selection, cancelling the discard confirmation to retain the draft, and Done applying the selected month in dark appearance at accessibility-medium text size. Its original light appearance and large text setting were restored afterward.

Local checks: 205 mobile tests across 39 files, mobile typecheck/lint and iOS/Android/web/DOM exports pass. Independent source reviews covered screen composition, access/sub-page draft behavior and view editing. These checks do not certify all edited screens on both platforms. Remaining composition work includes Activity, role management, longer agent/automation forms and record details; complete editor process-loss, keyboard, long-document and screen-reader acceptance, plus the full desktop parity checklist, remain open.

## Settings directories, roles and activity (2026-11-11)

Agents, Skills, Automations, Members, Connectors, Memory and Permissions share the screen gutter. Agent tool groups use the custom SettingsRow and native switches without a card per group or redundant disabled selectors. Agent, skill and automation editors use header commits. Descriptions wrap, supporting instructions use the shared text size, and invalid skill submission produces immediate native feedback even when its field is offscreen.

Role browsing, details, creation and rename share one sheet. Name editing is deliberate and protects drafts; permission switches retain immediate-save behavior and one accessible control per row. A mounted regression covers remote rename and permission loss without discarding the typed draft. Rename conflict protection covers changes observed by the client; the backend still has no atomic expected-name check.

Activity uses shared virtualized rows and readable detail sheets, retains complete before/after values and conversation routing, distinguishes loading/empty/pagination states, and reports bounded agent history. Details follow live query data so removed entries are not retained in a snapshot. Empty option arrays explicitly display Empty. Field-conversion Undo remains a desktop parity gap.

iPhone simulator checks: agent name draft/Cancel/Discard with unchanged directory data; invalid skill Create with a visible native alert; role list/detail/rename, keyboard-open layout and discard back to the unchanged role. Android emulator checks: centered agent-activity empty state, data-change rows and a populated before/after sheet, plus dark appearance at accessibility-medium text size. Original Android appearance and text size were restored. Agent execution, permission writes, populated agent-activity details and full role creation/rename persistence were not exercised.

Local validation: 206 mobile tests across 40 files, typecheck/lint and iOS/Android/web/DOM exports pass. Independent source reviews covered directory composition, header commits, role draft modes and live activity details. Remaining: longer agent/skill/automation form composition and record details; complete editor process-loss, keyboard, long-document and screen-reader acceptance; newer desktop capabilities and the full parity checklist. This remains a foundation checkpoint, not release acceptance.

## Readable details and protected property edits (2026-11-11)

Agents and Skills now open read-only detail routes. Native menus expose deliberate editing, picture/history, sharing and archive actions as applicable. Skill instructions render as Markdown; agent configuration, picture operations and version history have separate flows. Removed content is not retained in a stale detail snapshot, and permission loss preserves an open draft while preventing submission.

Record details and history use a shared PropertyRow component: transparent flex rows, selectable values, and stacked labels at narrow widths or larger text sizes. Full record names wrap in the body. Empty choices and locked references have explicit labels. Record creation dismisses its sheet before navigating. Clear value stages a change until Done; Undo clear restores the previous draft. Field and value editors block saves after observed schema/value changes or lost permissions while retaining drafts. These client guards are not atomic backend compare-and-set guarantees.

iPhone simulator acceptance: record creation, setting a choice value, staged clear followed by Cancel/Discard retaining the saved value, confirmed clear, and a history detail showing Before/After. Agent details, version list/detail and restore confirmation were exercised without restoring or changing agent configuration. Android emulator acceptance: property examples, persisted record values in dark appearance at accessibility-medium text size, agent detail/menu icons and Edit/Cancel, plus creating a local skill, rendered Markdown detail, native menu icons and Edit/Cancel. Screenshots were inspected; Android appearance and text size were restored. No paid agent execution, permission writes or external sharing occurred.

Local validation: 213 mobile tests across 45 files, typecheck/lint and iOS/Android/web/DOM exports pass. Independent reviews covered agent/skill routes and drafts, record composition, property edits and field-schema conflicts. Broader workspace suites were not rerun for this mobile-only checkpoint. Remaining: longer automation forms, populated connector and role-write acceptance, full editor process-loss/keyboard/long-document and screen-reader coverage, physical devices, newer desktop capabilities and full parity. The foundation goal remains open.

## Editor viewport and automation drafts (2026-11-11)

The document now owns one shared 20pt gutter instead of adding its padding to Screen padding. Native documents mount BlockNote's visual-viewport publisher independently of the disabled web toolbar. A focused editable caret is revealed after keyboard-driven viewport shrink without changing content or selection. Manual scrolling, scale-only resize, keyboard closure and unfocused/read-only documents do not request a caret scroll; listeners and pending frames are cleaned up. Mounted regressions reproduced the missing viewport properties before the repair and cover these transitions.

iPhone simulator acceptance: created a roughly 1,200-character, nine-paragraph document, scrolled to its end with the software keyboard open, selected a word and applied Bold through the native formatting menu, then navigated Back/reopened with text and formatting preserved. Dark appearance at accessibility-medium text size exposed a caret below the viewport on focus; after the repair, the same last-line tap reveals the caret above the keyboard before typing. Screenshots verify the shared gutter, floating toolbar and large-text wrapping. Original light appearance and large text setting were restored. Android opened the document saved from iPhone and rendered its full content with the new gutter. Software-keyboard setup stopped after the device tool twice failed to open Android Settings with a run-as sandbox error; Android keyboard acceptance remains incomplete.

Automation configuration now groups Task, Trigger and Runs using existing components, exposes validation on attempted submission, and includes native pause/play/archive menu icons. Permission loss retains the draft in a read-only editor; Reload latest resets both config and internal schedule controls. Three mounted regressions cover permission loss, versioned schedule reload/save and invalid creation. iPhone checks exercised invalid Create feedback, a name draft with the software keyboard, scrolling through the schedule/audience/time-zone controls at larger text in dark appearance, and Cancel/Discard returning to the unchanged empty directory. A prompt-fill command lost its runner response; a refreshed snapshot confirmed the prompt remained empty, so prompt-entry acceptance was not established. No automation was created or run.

Local validation: 219 mobile tests across 46 files, typecheck/lint and iOS/Android/web/DOM exports pass. Independent reviews covered automation behavior and editor viewport/caret cleanup. Broader workspace suites were not rerun for these mobile-only changes. Remaining acceptance includes Android keyboard/caret behavior, very large documents, actual process-loss recovery, screen readers, physical devices, populated connector/role writes and the full newer-desktop parity checklist. Schedule time entry still uses validated text fields; native time-selection composition remains a UX follow-up. This checkpoint does not establish full editor or release acceptance.

## Native time selection and document controls (2026-11-11)

The shared TimeInput uses Expo 58's compact iOS picker and Android time dialog. Recurring times stay HH:mm, with a fixed local reference date to prevent today's daylight-saving gap from altering a selected time. Daily, weekly and monthly automation controls use explicit Add/Remove time rows and the desktop cron compiler; incompatible time combinations remain validation errors. Hourly and advanced cron controls are unchanged. Date and time labels share the content edge and stack at larger text sizes.

Page creation now waits for native sheet dismissal before opening the document. Rename uses a compact Cancel/Done sheet, preserves drafts after permission loss and requires explicit reload after an observed remote title change. Move offers folders matching desktop, with loading/empty states and live source/destination capability checks. History previews use one document gutter; Restore requires available content and rechecks capability after confirmation. Client rename conflict detection is not an atomic backend version guard.

iPhone simulator acceptance: created a QA page, observed sheet dismissal followed by document navigation, renamed it with the software keyboard at accessibility-medium size, and verified the new title in the page list. Opened a populated history version and inspected the bounded preview and gutter at that text size without restoring content. Native time selection changed 09:00 to 10:00; dark gallery rendering stacked the controls without clipping. Android emulator acceptance: changed the time in the native dialog, inspected dark large-text and disabled gallery rows, and added/removed a time in the automation sheet with the summary reflecting both changes. No automation was created or run. Original text sizes were restored. Changing Android text size recreated the development activity and produced a duplicate-linking warning; dismissing the overlay and reopening the route recovered it, so activity-recreation reliability still needs investigation.

Local validation: 253 mobile tests across 50 files, typecheck/lint and iOS/Android/web/DOM exports pass. Independent reviews covered native time conversion, cron roundtrips, document controls, draft guards and sheet ordering. A stale automation test boundary found by review was updated and the full mobile suite rerun. Broader workspace suites were not rerun. Expo's iOS community date/time wrapper still exposes generic picker accessibility labels; VoiceOver/TalkBack acceptance is incomplete. Android editor keyboard/caret, actual process loss, physical devices, populated connector/role writes and full newer-desktop parity remain open.

## Native control and visual foundation checkpoint (2026-11-11)

Shared date/time adapters retain native field titles and localized values without duplicate iOS accessibility labels. iPhone checks covered time activation/change, disabled values and large-text dark rendering; full VoiceOver/TalkBack acceptance remains open. Android software-keyboard testing now uses the real IME: typing in the long QA document persisted after Back/reopen, and the last-line caret stayed above the floating toolbar at normal and accessibility-medium text size in dark appearance. Font-size changes recreate the Android activity; the development linking warning remains under investigation. A tracked expo-symbols patch prevents its decorative Material glyphs from scaling inside fixed bounds. The first post-patch Android visual check stopped after two snapshot-helper failures. A subsequent cold launch against the corrected Metro environment verified unclipped toolbar glyphs and native block-menu icons at accessibility-medium text size in dark appearance. The long document reopened with its previously saved Android marker intact; no document edits were made. Restoring light/large appearance recreated the activity, returned to Chats and reproduced the duplicate-linking development warning. That lifecycle issue remains unresolved.

The design pass keeps desktop neutrals and Phosphor content icons, with compact native tab titles, a shared section heading, consistent directory insets, 48pt minimum rows and desktop Settings grouping. Saved and pending chat messages share one author/metadata header and the app gutter. Markdown inline runs now inherit heading size, emphasis and link color; two regressions cover the prior style resets. The component gallery uses the same directory spacing and header submission recipe. Searchable root directories now resize their body for the keyboard, accounting for overlaid navigation chrome.

Current iPhone simulator checks cover the shared list gallery, Settings/General navigation, accessibility-medium Settings in dark appearance, normal/large chat metadata, native message-menu icons, and no-results search with the software keyboard plus Close restoring the list. Appearance and text size were restored to light/large. The development app was relaunched against the correct local backend after a Metro restart omitted its public URL. A development-only REMOVE_ROUTES warning appeared after refresh and was dismissed; it is not claimed resolved. No workspace data was changed by this visual pass.

Local mobile typecheck/lint and 255 tests across 51 files pass. Independent source review found no introduced blockers. All-platform exports pass. These checks are not whole-app visual or release acceptance. Remaining: editor process-loss recovery and very large documents, screen readers and physical devices, populated connector/role operations, and newer desktop capabilities including uploaded Drive files and some editor controls. EAS/signing and remote push setup remain open. Full parity and the overall goal remain incomplete.

## Android draft retention and current main (2026-11-11)

Changing system text size reproduced a lost New page draft and a return to Chats. The Android font-scale config plugin now preserves the activity, refreshes native layout and JavaScript dimensions, and updates DOM WebView zoom without reloading the editor. Emulator acceptance covered an unsaved title with the real keyboard, changes between large, small and accessibility-medium sizes, visible body/input/header resizing, declining discard to retain the draft, and confirmed discard without creating a page. A saved long document remained open while its text enlarged and shrank; its existing content was verified. No duplicate-linking overlay appeared during those font changes. Android native build, mobile typecheck/lint and plugin idempotence/config-preservation checks pass. The previous 255-test/export checkpoint was not rerun for this native-only repair. Process death and physical devices remain unverified.

Fetched main at `5f753f98`, already included in this branch. Desktop's Home, Chat, Inbox, Drive, Databases and Sites navigation and avatar/activity/invitation workspace switcher are the parity reference. Mobile still exposes Chats, Pages, Databases and Settings; matching the current desktop composition is unfinished. A deep link sent while the development app was still starting stayed on Chats; opening the same route after startup worked. Cold-start routing needs a separate reproduction and repair.
