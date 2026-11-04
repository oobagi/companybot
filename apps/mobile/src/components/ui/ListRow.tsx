import type { ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';

export type ListRowProps = {
  title: string;
  description?: string;
  value?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};
export function ListRow({ title, description, value, leading, trailing, onPress, onLongPress, selected, disabled, accessibilityLabel, style }: ListRowProps) {
  const { colors, spacing, sizes, radii } = useTheme();
  const rowStyle = [{ minHeight: sizes.touch, flexDirection: 'row' as const, alignItems: 'center' as const, padding: spacing.md, gap: spacing.md, borderRadius: radii.md, opacity: disabled ? 0.5 : 1 }, style];
  const content = <>{leading}<View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}><Text>{title}</Text>{description ? <Text variant="caption" tone="muted">{description}</Text> : null}</View>{value !== undefined && <Text tone="muted" style={{ flex: 1, textAlign: 'right' }}>{value}</Text>}{trailing}</>;
  if (!onPress) return <View style={rowStyle}>{content}</View>;
  return <Pressable onPress={onPress} onLongPress={onLongPress} disabled={disabled} android_ripple={{ color: colors.pressed }} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled: !!disabled, selected: !!selected }} style={({ pressed }) => [{ backgroundColor: selected ? colors.selected : pressed ? colors.pressed : 'transparent' }, ...rowStyle]}>{content}</Pressable>;
}
