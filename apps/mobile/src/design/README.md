# Mobile design system

Start with the [component library contract](components.md). The development app exposes a Components gallery through the root toolbar menu; verify components there before composing screens. Desktop’s neutral canvas, ink actions, restrained borders and Phosphor content icons carry over to mobile. Native headers, menus and tab bars keep platform rendering. Blue is reserved for content links. Use semantic color roles rather than adding feature-specific palettes. System typography respects the device's text size; custom touch controls use 48-point targets; system controls retain their native sizing (at least 44 points on iOS). Layout uses `spacing`, `radii`, `sizes` and `typography` from `@/design`.

Wrap the app once in `ThemeProvider`. It follows system appearance unless passed `appearance="light" | "dark"`. `useTheme()` returns `{ colors, spacing, radii, sizes, typography, dark }`; use those values for specialized layouts and navigation chrome. Keep domain data and navigation out of this layer.

Import the following from `@/components/ui`:

| Component | Props beyond native defaults |
| --- | --- |
| `Text` | Native Text props; `variant`: body (default), title, heading, label, supporting, caption; `tone`: default, muted, link, danger, inverse, success |
| `Button` | `label`, `onPress`, `disabled`, `loading`, `leading`, `testID`, accessibility label/hint/state, static View `style`; `variant`: primary (default), secondary, ghost, danger. Only capabilities supported by all native adapters are exposed. |
| `IconButton` | Native Pressable props; required accessible `label`, icon `children`; static View `style` |
| `Screen` | `children`, `scroll=false`, `nativeScroll=false`, `keyboard=false`, `keyboardOffset` (defaults to navigator header height), `edges=['left','right','bottom']`, `padded=true`, `contentStyle`, outer `style` |
| `ScreenList` | FlatList props except inset overrides; owns inset policy and measures its outer viewport for correctly centered empty content |
| `Stack` | Native View props; `gap`: spacing key (default lg); `horizontal=false` |
| `Card` | Native View props; plain bordered content container |
| `Section` | `title?`, `description?`, `action?` ReactNode, `children`, `style?` |
| `Field` | Native TextInput props; required `label`, optional `error`, `hint` |
| `ListRow` | `title`, `description?`, `value?`, `disclosure?`, `leading?`, `trailing?`, `onPress?`, `onLongPress?`, `selected?`, `disabled?`, `accessibilityLabel?`, `style?` |
| `Avatar` | `name`, `image?` URL, `agent=false` (square versus circular), `size`: sm, md (default), lg |
| `Badge` | `label`, `tone`: default, danger, success, warning |
| `EmptyState` | Native View props; `title`, `description?`, `action?`, `layout`: screen (default) or inline |
| `Loading` | Native View props; `label?`, `layout`: screen (default) or inline |
| `ErrorState` | `message`, `onRetry?`, `layout`: inline (default, validation/request error) or screen (centered full-page failure); View props |
| `Divider` | No props |

`Screen` is not itself a navigation header. Router owns back navigation and top safe area; headerless screens must include `top` in `edges`. Tab navigators may already own the bottom inset; omit `bottom` there. `Screen scroll` is for bounded forms and detail content. Use `Screen nativeScroll padded={false}` with `ScreenList` for automatically inset virtualized lists, and supply their content padding using the same spacing tokens. Native SwiftUI Form bodies also use `nativeScroll` because they own scroll insets. Do not nest a FlatList in a scrolling Screen.

For forms, enable `keyboard`; the screen uses padding on both platforms and obtains the header offset from Expo Router's header context. Expo's edge-to-edge Android guidance requires keyboard avoidance even when the window does not resize. Do not also enable Android keyboard pan. Complex forms may adopt Expo's recommended Keyboard Controller without changing the token layer.

Labels and descriptions wrap rather than imposing fixed line counts. Use truncation only where the feature also provides a way to read the full value. `ListRow` renders its `trailing` accessory beside its primary press target, so an action menu does not also open the row. Leading content is decorative. Avatar initials alone have a font scaling cap to stay inside their fixed image footprint; all normal text keeps unrestricted scaling.

Sources: [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/), [Expo keyboard guidance](https://docs.expo.dev/guides/keyboard-handling/), [safe area context](https://docs.expo.dev/versions/v58.0.0/sdk/safe-area-context/), [React Native accessibility](https://reactnative.dev/docs/accessibility), [scrolling and virtualization](https://reactnative.dev/docs/scrollview).

Use `NavigationHeader` from `@/components/navigation/NavigationHeader` for native search, creation and toolbar actions. It accepts data and callbacks, including an optional image or native icon for the leading action. `features/session/DirectoryHeader` supplies Companybot workspace data and destinations. The library does not fetch data or choose destinations. Search stays synchronized when a caller clears its value. Do not add a second title or a strip of creation/filter buttons below the system header. Prefer `ChoicePicker` for enumerated settings (native menu for up to eight single choices), `DateInput` for calendar dates, `EditorSheet` for editing and `useConfirm` for simple native decisions. Native tabs and stacks own their system insets; scrolling tab content uses automatic inset adjustment.

`@expo/ui` adapters own platform differences. Never import SwiftUI APIs in a universal file; use `.ios.tsx`/`.android.tsx` or the universal/drop-in API. Preserve busy/error and unsaved-work behavior when changing presentation. New controls must remain usable with system text scaling and dark appearance.

Scroll content fills the measured visible viewport using `minHeight`; do not add root `flexGrow: 1` on automatically inset lists. UIKit applies its insets after Yoga layout. Keep automatic UIKit insets, but measure the body’s real position in the window to subtract only the portion covered by its header. Native search can extend even an opaque-header route beneath navigation chrome; assuming transparency from stack options gives incorrect empty-state heights. `ScreenList` measures an outer View because React Native 0.88 also forwards empty-child layout events to FlatList's `onLayout`. Inner empty states can grow to center their copy. This follows the inset ownership used in Hunter King Theory's `fullscreen-scroll-view` and `tab-screen` primitives.

Creation starts with a New/Add toolbar action. Settings show values first and open guarded editors through Edit. Use `useDraftGuard` for sheet drafts: dirty content cannot be swiped away, Close confirms discard, and route/workspace changes participate in the same protection. Short forms use `EditorSheet size="content"`. Keep one task per sheet and use internal steps instead of nesting forms.

Content-sized sheets still have a bounded scrolling body: longer selections, larger text and keyboard use must keep the remaining fields and actions reachable. Use `scroll={false}` only when supplying a body that owns its own scrolling. The Components gallery includes a long form with inline selection specifically to exercise this boundary.

Use native `Stack.Toolbar.Button` and `Stack.Toolbar.Menu` in navigation bars, not an `ActionMenu` inside `headerRight`. iOS 26+ uses the native `scrollEdgeEffects` fade; do not layer a custom blur over it. Native Form controls own Settings row heights, icons, disclosure indicators and Dynamic Type.
