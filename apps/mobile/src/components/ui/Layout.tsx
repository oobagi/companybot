import { useContext, type ReactNode } from 'react';
import { FlatList, KeyboardAvoidingView, ScrollView, StyleSheet, View, type FlatListProps, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';
import { useTheme, type spacing as SpaceTokens } from '@/design';
import { Text } from './Text';
import { OverlayChromeContext, ScrollInsetsContext, useScrollViewport } from './scrollViewport';

export type ScreenProps = {
  children: ReactNode;
  scroll?: boolean;
  /** The body contains a ScreenList, which owns automatic native scroll insets. */
  nativeScroll?: boolean;
  keyboard?: boolean;
  keyboardOffset?: number;
  edges?: Edge[];
  padded?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
};

/** Static bodies trim overlay chrome; scrollers let UIKit own those insets. */
export function Screen({ children, scroll = false, nativeScroll = false, keyboard = false, keyboardOffset, edges = ['left', 'right', 'bottom'], padded = true, contentStyle, style }: ScreenProps) {
  const { colors, spacing } = useTheme();
  // Same source as useHeaderHeight(), with a zero fallback for pre-navigation setup screens.
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const overlay = useContext(OverlayChromeContext);
  const safe = useSafeAreaInsets();
  // SafeAreaView has already removed any requested edges from the measured viewport.
  const insets = {
    top: overlay ? Math.max(0, Math.max(headerHeight, safe.top) - (edges.includes('top') ? safe.top : 0)) : 0,
    bottom: overlay && !edges.includes('bottom') ? safe.bottom : 0,
  };
  const { ref: viewportRef, onLayout: measureViewport, contentStyle: viewportContent } = useScrollViewport(insets);
  const scrolling = scroll || nativeScroll;
  const content = [!scroll && styles.fill, padded && { padding: spacing.lg }, contentStyle, scroll && viewportContent];
  return (
    <SafeAreaView collapsable={false} edges={edges} style={[styles.fill, { backgroundColor: colors.background }, style]}>
      <KeyboardAvoidingView collapsable={false} enabled={keyboard} behavior="padding" keyboardVerticalOffset={keyboardOffset ?? headerHeight} style={[styles.fill, !scrolling && { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <OverlayChromeContext.Provider value={false}><ScrollInsetsContext.Provider value={scrolling ? insets : { top: 0, bottom: 0 }}>
          {scroll ? <View ref={viewportRef} collapsable={false} style={styles.fill} onLayout={measureViewport}><ScrollView style={styles.fill} contentInsetAdjustmentBehavior="automatic" automaticallyAdjustContentInsets={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={content}>{children}</ScrollView></View> : <View collapsable={false} style={content}>{children}</View>}
        </ScrollInsetsContext.Provider></OverlayChromeContext.Provider>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Screen owns overlay measurements; this list owns native inset adjustment. */
export type ScreenListProps<Item> = Omit<FlatListProps<Item>, 'contentInset' | 'contentInsetAdjustmentBehavior' | 'automaticallyAdjustContentInsets' | 'automaticallyAdjustsScrollIndicatorInsets' | 'scrollIndicatorInsets'>;

/** A virtualized body using the same measured visible area as Screen scroll.
 * Use FlatList directly for custom/manual insets instead of mixing inset owners. */
export function ScreenList<Item>({ contentContainerStyle, style, ...props }: ScreenListProps<Item>) {
  const insets = useContext(ScrollInsetsContext);
  const { ref: viewportRef, onLayout: measureViewport, contentStyle: viewportContent } = useScrollViewport(insets);
  // RN 0.88 also calls FlatList's onLayout for its empty child. Measure a separate
  // native container so child sizing cannot feed back into the viewport height.
  return <View ref={viewportRef} collapsable={false} style={styles.fill} onLayout={measureViewport}>
    <FlatList {...props} contentInsetAdjustmentBehavior="automatic" automaticallyAdjustContentInsets={false} automaticallyAdjustsScrollIndicatorInsets contentInset={undefined} scrollIndicatorInsets={undefined} style={[styles.fill, style]} contentContainerStyle={[contentContainerStyle, viewportContent]} />
  </View>;
}

export function Stack({ gap = 'lg', horizontal = false, style, ...props }: ViewProps & { gap?: keyof typeof SpaceTokens; horizontal?: boolean }) {
  const { spacing } = useTheme();
  return <View {...props} style={[{ gap: spacing[gap], flexDirection: horizontal ? 'row' : 'column', ...(horizontal ? { alignItems: 'center' as const } : {}) }, style]} />;
}

export function Card({ style, ...props }: ViewProps) {
  const { colors, radii, spacing } = useTheme();
  return <View {...props} style={[{ backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md }, style]} />;
}

export function Divider() {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />;
}

export function Section({ title, description, action, children, style }: { title?: string; description?: string; action?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { spacing } = useTheme();
  return <View style={[{ gap: spacing.md }, style]}>
    {(title || action) && <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={{ flex: 1, gap: spacing.xs }}>{title && <Text variant="label" accessibilityRole="header">{title}</Text>}{description && <Text tone="muted" variant="supporting">{description}</Text>}</View>
      {action}
    </View>}
    {children}
  </View>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
