import type { ReactNode } from 'react';
import { I18nManager, Pressable, StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { radii, sizes, spacing, useTheme } from '@/design';
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
  /** Text selection is useful for read-only content rows. */
  selectable?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

/** Screen or list owns the horizontal gutter. Rows add vertical rhythm only. */
export function ListRow({ title, description, value, disclosure = false, leading, trailing, onPress, onLongPress, selected, selectable = false, disabled, accessibilityLabel, style }: ListRowProps) {
  const { colors } = useTheme();
  const { fontScale, width } = useWindowDimensions();
  const stacked = fontScale >= 1.4 || width < 360;
  const content = <>
    {leading && <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={rowStyles.leading}>{leading}</View>}
    <View style={[rowStyles.copy, { flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'stretch' : 'center' }]}>
      <View style={rowStyles.text}>
        <Text selectable={selectable}>{title}</Text>
        {description ? <Text variant="supporting" tone="muted">{description}</Text> : null}
      </View>
      {value !== undefined && <Text tone="muted" style={{ flexShrink: 1, ...(stacked ? {} : { maxWidth: '50%', textAlign: 'right' as const }) }}>{value}</Text>}
    </View>
    {disclosure && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><SymbolView name={{ ios: I18nManager.isRTL ? 'chevron.left' : 'chevron.right', android: I18nManager.isRTL ? 'chevron_left' : 'chevron_right', web: I18nManager.isRTL ? 'chevron_left' : 'chevron_right' }} size={16} tintColor={colors.muted} /></View>}
  </>;
  const appearance = { opacity: disabled ? 0.5 : 1, backgroundColor: selected ? colors.selected : 'transparent' };
  return <View style={[rowStyles.container, style]}>
    {onPress ? <Pressable onPress={onPress} onLongPress={onLongPress} disabled={disabled} android_ripple={{ color: colors.pressed }} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled: !!disabled, selected: !!selected }} style={({ pressed }) => [rowStyles.row, { flex: 1 }, appearance, pressed && !selected && { backgroundColor: colors.pressed }]}>{content}</Pressable> : <View style={[rowStyles.row, { flex: 1 }, appearance]}>{content}</View>}
    {trailing}
  </View>;
}

/** Shared geometry for content and settings rows, without coupling their interactions. */
export const rowStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', minWidth: 0, gap: spacing.md },
  row: { minWidth: 0, minHeight: sizes.touch, flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, gap: spacing.md, borderRadius: radii.md },
  leading: { minWidth: sizes.avatar.md, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, minWidth: 0, gap: spacing.sm },
  text: { flex: 1, minWidth: 0, gap: spacing.xs },
});
