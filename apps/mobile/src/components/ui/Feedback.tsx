import type { ReactNode } from 'react';
import { ActivityIndicator, View, type ViewProps } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';
import { Button } from './Button';

export type FeedbackLayout = 'screen' | 'inline';
type FeedbackProps = ViewProps & { layout?: FeedbackLayout };

/** Screen feedback fills its available area; Screen/ScreenList own viewport sizing. */
export function EmptyState({ title, description, action, layout = 'screen', style, ...props }: FeedbackProps & { title: string; description?: string; action?: ReactNode }) {
  const { spacing } = useTheme();
  return <View {...props} style={[{ flexGrow: layout === 'screen' ? 1 : 0, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: layout === 'screen' ? spacing.xl : spacing.lg, width: '100%' }, style]}>
    <View style={{ width: '100%', maxWidth: 360, alignItems: 'center', gap: spacing.sm }}>
      <Text variant={layout === 'screen' ? 'heading' : 'label'} accessibilityRole="header" style={{ textAlign: 'center' }}>{title}</Text>
      {description && <Text variant={layout === 'screen' ? 'body' : 'caption'} tone="muted" style={{ textAlign: 'center' }}>{description}</Text>}
      {action && <View style={{ marginTop: spacing.sm }}>{action}</View>}
    </View>
  </View>;
}

export function Loading({ label = 'Loading…', layout = 'screen', style, ...props }: FeedbackProps & { label?: string }) {
  const { colors, spacing } = useTheme();
  return <View {...props} accessibilityState={{ busy: true }} accessibilityLabel={label} accessible style={[{ flexGrow: layout === 'screen' ? 1 : 0, flexDirection: layout === 'screen' ? 'column' : 'row', alignItems: 'center', justifyContent: 'center', padding: layout === 'screen' ? spacing.xl : spacing.md, gap: spacing.sm }, style]}><ActivityIndicator color={colors.muted} /><Text variant="caption" tone="muted" style={{ textAlign: 'center', flexShrink: 1 }}>{label}</Text></View>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { colors, radii, spacing } = useTheme();
  return <View style={{ gap: spacing.md, padding: spacing.lg, borderRadius: radii.md, backgroundColor: colors.dangerSurface }}>
    <Text accessibilityRole="alert" accessibilityLiveRegion="polite" tone="danger">{message}</Text>
    {onRetry && <Button label="Try again" variant="secondary" onPress={onRetry} />}
  </View>;
}
