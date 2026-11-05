# Component library contract

Build and inspect the components before composing feature screens. The development Components route is the reference for light/dark appearance, long content, large text, empty/loading/error states, and deliberate form entry.

## Foundation

- One semantic token set owns color, spacing, typography and touch targets. Native controls retain platform typography and interaction. Use blue for actions, neutral surfaces for content, and red only for destructive operations/errors.
- `Screen` owns the bounded flex viewport and safe-area policy. Choose one scroll owner: `Screen scroll`, `ScreenList`, or a native `GroupedList`. Never nest these scrollers. A bounded DOM editor opts out of both UIKit and legacy automatic native content insets. It imports the editor core and React styles explicitly; do not rely on the skin’s nested CSS imports through Metro.
- `Stack` is a simple row/column with token spacing. `Section` groups ordinary content; `Card` is for independently meaningful content, not a wrapper around every row.
- Router owns titles, back buttons and navigation actions. Do not repeat the title in the body or add a strip of utility buttons.

## Screen building blocks

| Component | Purpose | Ownership |
| --- | --- | --- |
| `GroupedList` | Settings, properties, disclosure and toggle rows | Platform-native scrolling, sections, row spacing and separators |
| `ListRow` | Custom directory/content row | Simple flex layout; independent accessory outside its navigation press target |
| `ChoicePicker` | Selected value with deliberate selection | Native menu for short choices; searchable selection for long/multiple choices; row or compact presentation |
| `Field` | Labeled text entry inside an editor | Native TextInput, focus, keyboard semantics, hint and validation |
| `EditorSheet` | A single explicit editing task | Native sheet, header, keyboard and dismissal behavior |
| `ContentToolbar` | Editing actions at the bottom of a bounded content area | Platform-native icon controls; decorative status; no domain imports |
| `HeaderMenu` / `NavigationHeader` | Navigation actions, search and creation | Native toolbar buttons, icons and menus; caller-supplied data and callbacks |
| `EmptyState` / `Loading` / `ErrorState` | Feedback | Centered screen state or explicitly inline feedback |

## Composition rules

A normal screen is a native header followed by one flex body. Put a toolbar after the body when needed. The body is either a scrolling grouped list, virtualized content list, or a bounded editor. Avoid per-screen height arithmetic, duplicate padding wrappers and fixed-height content panes.

Rows display values. Tapping Edit or a row opens a form; forms do not occupy a browsing screen. A navigation row cannot contain another press target: place its menu in the separate accessory slot. Text wraps and controls remain reachable at accessibility text sizes.

Use `ListRow selectable` for content that needs native text selection, with editing actions in its separate menu rather than an enclosing row press target. Memory uses this pattern so read-only content can still be copied.

Native library files have no Convex, workspace, router destination, or product-specific dependencies. Features provide labels, values and callbacks. Do not add per-feature colors, radius overrides or arbitrary row sizing props.

ESLint enforces the feature/server import boundary for the token, UI and navigation folders. Product adapters, including `features/session/DirectoryHeader`, live with features. Shared APIs expose only behavior that works on each platform; unsupported Pressable callbacks and conflicting list inset overrides are rejected by TypeScript.

Before migrating a screen, prove its necessary components in the gallery. Validate actual native rendering and interactions; typecheck and export are necessary but do not prove visual quality.

## Recipes to compose

- **Directory:** `NavigationHeader` + `Screen nativeScroll padded={false}` + `ScreenList`, with `ListRow`, a separator, and `EmptyState` as `ListEmptyComponent`. Search and New belong in native chrome. See `features/development/DirectoryExample.tsx` for local search, empty state, explicit creation and controlled search reset.
- **Settings or properties:** `Screen nativeScroll padded={false}` + `GroupedList`. Display values and open an `EditorSheet` from an intentional row or Edit action.
- **Form:** `EditorSheet` + `Field` / `ChoicePicker` / `DateInput` + `Button`. The feature owns draft state, validation and submission. `useDraftGuard` owns dismissal protection.
- **Bounded editor:** `Screen padded={false}` + a flex body + `ContentToolbar`. The body owns editing and the toolbar receives actions/status. Native toolbars show up to three direct actions and put the rest in a native overflow menu; busy/disabled actions cannot dispatch through either path.
- **Feedback:** `EmptyState`, `Loading` or `ErrorState layout="screen"` fills the remaining body. Use `layout="inline"` inside populated content. `FeedbackExample.tsx` exercises static, scrolling and virtualized containers with the same component.

The gallery keeps demonstration state local. Its nine examples cover these recipes plus typography, button hierarchy, independent row/menu targets, long forms, busy/disabled controls and appearance switching. New feature screens should be compositions of these examples, with only domain-specific content added.

## Native gallery verification (2026-11-04)

Pixel 10 Pro / Android API 37.1: inspected all eight gallery examples in light and dark appearance. Verified grouped rows and toggles, compact selection, searchable multiple selection, preserved drafts through Cancel/Discard, separate row/menu targets, toolbar actions and retry. iPhone 18 Pro Max / iOS27: inspected grouped lists at normal and accessibility-large text sizes, compact/row menus, deliberate native date picker, bottom toolbar and centered feedback. Large-text value rows stack rather than squeezing labels into columns; native host measurements refresh when text size or selected labels change.

The gallery is development-only at `/components`, also available from the tab-root More menu. It uses local demonstration state and does not write sample values to a workspace. Feature migration is incremental: a gallery pass does not certify every existing screen.

The library hardening pass verifies native directory search/reset, deliberate form entry and draft protection, long inline selections with reachable Save/Close, virtualized empty/loading feedback, retry, and native toolbar overflow on both simulators. iOS search exposed a route frame extending beneath an apparently opaque header; measuring the real frame fixes centering both with search active and inactive, while preserving tab-root behavior. Disabled/loading iOS button labels now retain readable contrast. Android checks include 150% text; iOS checks include accessibility-large text. Software-keyboard coverage remains incomplete: Android used a floating keyboard and iOS used simulator hardware input.
