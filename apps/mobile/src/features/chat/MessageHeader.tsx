import type { ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Avatar, Text } from '@/components/ui';
import { useTheme } from '@/design';

/** A caller can wrap the author in a profile link without enclosing the menu. */
export function MessageHeader({ children, metadata, action }: { children: ReactNode; metadata?: string; action?: ReactNode }) {
  const { sizes, spacing } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale >= 1.4;
  return <View style={{ minHeight: sizes.touch, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
    <View style={{ flex: 1, minWidth: 0, flexDirection: stacked ? 'column' : 'row', flexWrap: 'wrap', alignItems: stacked ? 'stretch' : 'center', columnGap: spacing.sm }}>
      {children}
      {metadata && <Text variant="caption" tone="muted" style={{ flexShrink: 1, marginStart: stacked ? sizes.avatar.sm + spacing.sm : 0 }}>{metadata}</Text>}
    </View>
    {action}
  </View>;
}

/** Plain author identity, shared by saved messages and local pending messages. */
export function MessageAuthor({ name, image, agent = false }: { name: string; image?: string | null; agent?: boolean }) {
  const { spacing } = useTheme();
  return <View style={{ minWidth: 0, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><Avatar name={name} image={image} agent={agent} size="sm" /></View>
    <Text variant="label" style={{ flexShrink: 1 }}>{name}{agent && <Text variant="caption" tone="muted"> · Bot</Text>}</Text>
  </View>;
}
