import { Pressable, View, useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import { Text } from './Text';

/** Record data keeps the value primary; larger text stacks the label above it. */
export function PropertyRow({ label, value, onPress, disabled = false }: { label: string; value: string; onPress?: () => void; disabled?: boolean }) {
  const { spacing, sizes, colors } = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const stacked = width < 360 || fontScale >= 1.4;
  const content = <View style={{ flex: 1, minWidth: 0, flexDirection: stacked ? 'column' : 'row', gap: spacing.sm, paddingVertical: spacing.md }}>
    <Text tone="muted" style={stacked ? undefined : { width: '35%' }}>{label}</Text>
    <Text selectable={!onPress} tone={onPress && !disabled ? 'link' : 'default'} style={{ flex: 1, minWidth: 0 }}>{value}</Text>
  </View>;
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={`${label}, ${value}`} accessibilityHint={`Edit ${label}`} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: sizes.touch, flexDirection: 'row', backgroundColor: pressed ? colors.pressed : 'transparent' })}>{content}</Pressable>
    : <View style={{ minHeight: sizes.touch, flexDirection: 'row' }}>{content}</View>;
}
