import type { PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';
import type { ContentToolbarProps } from './ContentToolbar.types';

export function ContentToolbarFrame({ children, status, busy, accessibilityLabel = 'Editing actions' }: PropsWithChildren<Pick<ContentToolbarProps, 'status' | 'busy' | 'accessibilityLabel'>>) {
  const { colors, spacing } = useTheme();
  return <View accessibilityRole="toolbar" accessibilityLabel={accessibilityLabel} accessibilityState={{ busy }} style={{ backgroundColor: colors.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingHorizontal: spacing.md }}>
    {status ? <Text variant="caption" tone="muted" accessibilityLiveRegion="polite" style={{ paddingTop: spacing.sm }}>{status}</Text> : null}
    {children}
  </View>;
}
