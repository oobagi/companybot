# Component library contract

Build and inspect the components before composing feature screens. The development Components route is the reference for light/dark appearance, long content, large text, empty/loading/error states, and deliberate form entry.

## Foundation

- One semantic token set owns color, spacing, typography and touch targets. Body and input text is 17pt, supporting descriptions and section headings 15pt, and brief metadata 13pt. Row labels are regular; headings and form labels use medium weight. Native controls keep scalable platform text styles; the DOM editor receives the native font scale. Match desktop's neutral primary actions and selections, with sky blue for links and red for destructive operations/errors.
- `sizes.gutter` is the 20pt content edge. `Screen` supplies it by default; standalone `ScreenList` callers supply it once. `SettingsList` supplies it internally. Root directories and the gallery share `listContentStyle`: 20pt horizontal, 8pt top and 24pt bottom padding. Rows have a 48pt minimum target and 8pt vertical padding; multiline content expands them. `SectionHeading` owns the muted, medium-weight 15pt section label. `ListRow` and `SettingsRow` share vertical padding and a 32pt leading slot without adding another horizontal inset. Section headings align to the content edge. `Field` uses a neutral outline and the same input/body typography.
- `Screen` owns the bounded flex viewport and safe-area policy. Choose one scroll owner: `Screen scroll`, `ScreenList`, or `SettingsList` (which uses `ScreenList`). Never nest these scrollers. A bounded DOM editor opts out of both UIKit and legacy automatic native content insets. It imports the editor core and React styles explicitly; do not rely on the skin’s nested CSS imports through Metro.
- `Stack` is a simple row/column with token spacing. `Section` groups ordinary content; `Card` is for independently meaningful content, not a wrapper around every row.
- Router owns compact titles, back buttons and navigation actions. Avoid duplicated title labels and strips of utility buttons. Entity pages may show a wrapping, selectable title in the body when a compact header would truncate the full name.

## Screen building blocks

| Component | Purpose | Ownership |
| --- | --- | --- |
| `SettingsList` / `SettingsGroup` / `SettingsRow` | Settings, disclosure and toggle rows | Shared React Native flex rows, one scroll owner, native symbols and switches; transparent groups without cards or separators |
| `PropertyRow` | Record values and before/after history | Muted label and body-sized value; stacks at larger text sizes, selectable read-only values and explicit editing targets |
| `ListRow` | Custom directory/content row | Simple flex layout; independent accessory outside its navigation press target |
| `ChoicePicker` | Selected value with deliberate selection | Native menu for short choices; searchable selection for long/multiple choices; row or compact presentation |
| `MonthPicker` | Calendar-month filter | One Period row opens a Cancel/Done sheet; month/year changes remain local until committed |
| `DateInput` / `TimeInput` | Calendar date or recurring wall-clock time | Native compact iOS picker and Android dialog; time values remain HH:mm without converting the schedule time zone |
| `Field` | Labeled text entry inside an editor | Native TextInput, focus, keyboard semantics, hint and validation |
| `EditorSheet` | A single explicit editing task | Native sheet, header, keyboard and dismissal behavior |
| `ContentToolbar` / `ContentToolbarFrame` | Editing actions at the bottom of a bounded content area | Compact native icon controls inside `FloatingBar`; accessible status; no domain imports. The frame also accepts domain-owned native menus |
| `FloatingBar` | A floating control surface | Native iOS glass where available; plain bordered fallback. No color/shape variants |
| `HeaderMenu` / `NavigationHeader` | Navigation actions, search and creation | Native toolbar buttons, icons and menus; caller-supplied data and callbacks |
| `EmptyState` / `Loading` / `ErrorState` | Feedback | Centered screen state or explicitly inline feedback |

## Composition rules

A normal screen is a native header followed by one flex body. Put a toolbar after the body when needed. The body is either a scrolling settings list, virtualized content list, or a bounded editor. Avoid per-screen height arithmetic, duplicate padding wrappers and fixed-height content panes.

Rows display values. Tapping Edit or a row opens a form; forms do not occupy a browsing screen. A navigation row cannot contain another press target: place its menu in the separate accessory slot. Text wraps and controls remain reachable at accessibility text sizes.

Use `ListRow selectable` for content that needs native text selection, with editing actions in its separate menu rather than an enclosing row press target. Memory uses this pattern so read-only content can still be copied.

`InlineText` preserves inherited typography inside formatted paragraphs and headings. Use it for emphasis and links; nested `Text` would reset the surrounding font style. Chat uses a shared `MessageHeader` for author identity, timestamp and an independent native menu target.

Native library files have no Convex, workspace, router destination, or product-specific dependencies. Features provide labels, values and callbacks. Do not add per-feature colors, radius overrides or arbitrary row sizing props.

ESLint enforces the feature/server import boundary for the token, UI and navigation folders. Product adapters, including `features/session/DirectoryHeader`, live with features. Shared APIs expose only behavior that works on each platform; unsupported Pressable callbacks and conflicting list inset overrides are rejected by TypeScript.

Before migrating a screen, prove its necessary components in the gallery. Validate actual native rendering and interactions; typecheck and export are necessary but do not prove visual quality.

## Recipes to compose

- **Directory:** `NavigationHeader` + `Screen nativeScroll padded={false}` + `ScreenList`, with `listContentStyle`, `ListRow` and `EmptyState` as `ListEmptyComponent`. Search and New belong in native chrome. See `features/development/DirectoryExample.tsx` for local search, empty state, explicit creation and controlled search reset.
- **Settings or properties:** `Screen nativeScroll padded={false}` + `SettingsList`. Display values and open an `EditorSheet` from an intentional row or Edit action.
- **Form:** `EditorSheet` + `Field` / `ChoicePicker` / `DateInput` / `TimeInput`. Pass `submit` for a Cancel/title/Done header; do not duplicate that commit action in the body. The feature owns draft state, validation and submission. `useDraftGuard` owns dismissal protection. The native sheet owns keyboard avoidance; its RN scroller must not add another automatic keyboard inset. iOS choice-menu labels use SwiftUI text constrained to the measured host width, allowing natural height and multiline values at accessibility sizes. Creation that opens the new entity must wait for sheet dismissal before navigating.
- **Bounded editor:** `Screen padded={false}` + a flex body + `ContentToolbar`. The body owns editing and the toolbar receives actions/status. Native toolbars show up to three direct actions and put the rest in a native overflow menu; busy/disabled actions cannot dispatch through either path.
- **Document editing:** `DocumentToolbar` composes `ContentToolbarFrame` with three native menus for formatting, insertion and block actions. Selection and document mutations stay inside the DOM editor; no duplicate web formatting bar appears on native. Link editing uses `EditorSheet` with Cancel/Done and draft protection.
- **Document viewport:** the page is unpadded and the DOM editor owns the shared gutter. Keep BlockNote's viewport publisher mounted independently of its disabled web toolbar. When the keyboard shrinks the visible viewport, reveal a focused editable caret after layout; manual scrolling, zoom alone and keyboard closure must not jump back to the selection.
- **Feedback:** `EmptyState`, `Loading` or `ErrorState layout="screen"` fills the remaining body. Use `layout="inline"` inside populated content. `FeedbackExample.tsx` exercises static, scrolling and virtualized containers with the same component.

The gallery keeps demonstration state local. Its eleven examples cover these recipes plus typography, button hierarchy, independent row/menu targets, long forms, busy/disabled controls, pending messages and appearance switching. New feature screens should be compositions of these examples, with only domain-specific content added.

Compact iOS choice triggers use SwiftUI text and symbols directly. Embedding a React Native label in the size-matching menu host lost its text inside a native sheet. Row presentations use a full-width host with an explicitly measured label width. Page history composes `EditorSheet` with a bounded body rather than a separate modal/header implementation.

## Native gallery verification (2026-11-04)

Pixel 10 Pro / Android API 37.1: inspected all eight gallery examples in light and dark appearance. Verified grouped rows and toggles, compact selection, searchable multiple selection, preserved drafts through Cancel/Discard, separate row/menu targets, toolbar actions and retry. iPhone 18 Pro Max / iOS27: inspected grouped lists at normal and accessibility-large text sizes, compact/row menus, deliberate native date picker, bottom toolbar and centered feedback. Large-text value rows stack rather than squeezing labels into columns; native host measurements refresh when text size or selected labels change.

The gallery is development-only at `/components`, also available from the tab-root More menu. It uses local demonstration state and does not write sample values to a workspace. Feature migration is incremental: a gallery pass does not certify every existing screen.

The library hardening pass verifies native directory search/reset, deliberate form entry and draft protection, long inline selections with reachable Save/Close, virtualized empty/loading feedback, retry, and native toolbar overflow on both simulators. iOS search exposed a route frame extending beneath an apparently opaque header; measuring the real frame fixes centering both with search active and inactive, while preserving tab-root behavior. Disabled/loading iOS button labels now retain readable contrast. Android checks include 150% text; iOS checks include accessibility-large text. Software-keyboard coverage remains incomplete: Android used a floating keyboard and iOS used simulator hardware input.

## Custom settings composition (2026-11-05)

At this checkpoint, Settings adopted Stuff’s flat custom list composition and HKT’s consistent label hierarchy. `SettingsList` owns scrolling; `SettingsGroup` and `SettingsRow` are non-scrolling building blocks. The original 24pt inset and semibold rows have since been replaced by the shared row geometry described above. Native symbols, switches, navigation, menus and sheets retain their platform behavior. No per-screen row styling, background variants or separate native list renderers. Values stack at accessibility sizes; text is not line-clamped. Toggle copy has one accessibility owner: the native Switch.

The iPhone gallery was visually checked at normal and accessibility-large text. Settings and General were checked at normal text on iPhone and Android; iPhone Settings was also checked in dark appearance. Both simulators passed navigation into General and scrolling to the final Sign out row without activating it. The profile picker was checked at accessibility-large, including changing a value and cancelling through the discard prompt. This does not certify the complete large-text, VoiceOver, appearance or keyboard matrix.
