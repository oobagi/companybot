import type { ReactNode } from 'react';
import { ActivityIndicator, ScrollView, View, type ViewProps } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';
import { Button } from './Button';

export type FeedbackLayout = 'screen' | 'inline';
type FeedbackProps = ViewProps & { layout?: FeedbackLayout };

/** Fill a bounded body, but keep oversized feedback reachable. Parent screens own insets. */
function FeedbackFrame({ layout, style, children, ...props }: FeedbackProps) {
  if (layout === 'inline') return <View {...props} style={style}>{children}</View>;
  return <ScrollView {...props} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, width: '100%' }} contentContainerStyle={style}
    contentInsetAdjustmentBehavior="never" automaticallyAdjustContentInsets={false} automaticallyAdjustsScrollIndicatorInsets={false}
    nestedScrollEnabled keyboardShouldPersistTaps="handled" bounces={false}>{children}</ScrollView>;
}

/** Screen feedback centers when it fits and scrolls when larger text exceeds the viewport. */
export function EmptyState({ title, description, action, layout = 'screen', style, ...props }: FeedbackProps & { title: string; description?: string; action?: ReactNode }) {
  const { spacing } = useTheme();
  return <FeedbackFrame {...props} layout={layout} style={[{ flexGrow: layout === 'screen' ? 1 : 0, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: layout === 'screen' ? spacing.xl : spacing.lg, width: '100%' }, style]}>
    <View style={{ width: '100%', maxWidth: 360, alignItems: 'center', gap: spacing.sm }}>
      <Text variant={layout === 'screen' ? 'heading' : 'label'} accessibilityRole="header" style={{ textAlign: 'center' }}>{title}</Text>
      {description && <Text variant={layout === 'screen' ? 'body' : 'supporting'} tone="muted" style={{ textAlign: 'center' }}>{description}</Text>}
      {action && <View style={{ marginTop: spacing.sm }}>{action}</View>}
    </View>
  </FeedbackFrame>;
}

export function Loading({ label = 'Loading…', layout = 'screen', style, ...props }: FeedbackProps & { label?: string }) {
  const { colors, spacing } = useTheme();
  return <FeedbackFrame {...props} layout={layout} accessibilityState={{ busy: true }} accessibilityLabel={label} accessible style={[{ flexGrow: layout === 'screen' ? 1 : 0, flexDirection: layout === 'screen' ? 'column' : 'row', alignItems: 'center', justifyContent: 'center', padding: layout === 'screen' ? spacing.xl : spacing.md, gap: spacing.sm }, style]}><ActivityIndicator color={colors.muted} /><Text variant="supporting" tone="muted" style={{ textAlign: 'center', flexShrink: 1 }}>{label}</Text></FeedbackFrame>;
}

export function ErrorState({ message, onRetry, layout = 'inline', style, ...props }: FeedbackProps & { message: string; onRetry?: () => void }) {
  const { colors, radii, spacing } = useTheme();
  if (layout === 'screen') return <EmptyState {...props} title="Something went wrong" description={message} style={style} accessibilityRole="alert" accessibilityLiveRegion="polite" action={onRetry && <Button label="Try again" variant="secondary" onPress={onRetry} />} />;
  return <View {...props} style={[{ gap: spacing.md, padding: spacing.lg, borderRadius: radii.md, backgroundColor: colors.dangerSurface }, style]}>
    <Text accessibilityRole="alert" accessibilityLiveRegion="polite" tone="danger">{message}</Text>
    {onRetry && <Button label="Try again" variant="secondary" onPress={onRetry} />}
  </View>;
}
