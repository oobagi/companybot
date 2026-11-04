import type { ReactNode } from 'react';
import { Pressable, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useTheme } from '@/design';
import { Text } from './Text';

export type ListRowProps = {
  title: string;
  description?: string;
  value?: string;
  disclosure?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};
export function ListRow({ title, description, value, disclosure = false, leading, trailing, onPress, onLongPress, selected, disabled, accessibilityLabel, style }: ListRowProps) {
  const { colors, spacing, sizes, radii } = useTheme();
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale >= 1.4;
  const rowStyle = { flex: 1, minWidth: 0, minHeight: sizes.touch, flexDirection: 'row' as const, alignItems: 'center' as const, padding: spacing.md, gap: spacing.md, borderRadius: radii.md, opacity: disabled ? 0.5 : 1 };
  const content = <>{leading}<View style={{ flex: 1, minWidth: 0, flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center', gap: spacing.sm }}><View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}><Text>{title}</Text>{description ? <Text variant="caption" tone="muted">{description}</Text> : null}</View>{value !== undefined && <Text tone="muted" style={{ flexShrink: 1, ...(stacked ? {} : { maxWidth: '55%', textAlign: 'right' as const }) }}>{value}</Text>}</View>{disclosure && <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={16} tintColor={colors.muted} />}</>;
  return <View style={[{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }, style]}>
    {onPress ? <Pressable onPress={onPress} onLongPress={onLongPress} disabled={disabled} android_ripple={{ color: colors.pressed }} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled: !!disabled, selected: !!selected }} style={({ pressed }) => [rowStyle, { backgroundColor: selected ? colors.selected : pressed ? colors.pressed : 'transparent' }]}>{content}</Pressable> : <View style={rowStyle}>{content}</View>}
    {trailing}
  </View>;
}
