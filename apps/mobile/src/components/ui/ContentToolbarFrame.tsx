import type { PropsWithChildren } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';
import { FloatingBar } from './FloatingBar';
import type { ContentToolbarProps } from './ContentToolbar.types';

export function ContentToolbarFrame({ children, status, busy, accessibilityLabel = 'Editing actions' }: PropsWithChildren<Pick<ContentToolbarProps, 'status' | 'busy' | 'accessibilityLabel'>>) {
  const { spacing } = useTheme();
  return <View accessibilityRole="toolbar" accessibilityLabel={accessibilityLabel} accessibilityState={{ busy }} style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.xs }}>
    {status ? <Text variant="supporting" tone="muted" accessibilityLiveRegion="polite" style={{ textAlign: 'center' }}>{status}</Text> : null}
    <View style={{ alignSelf: 'center', maxWidth: '100%' }}><FloatingBar>{children}</FloatingBar></View>
  </View>;
}
