import type { ComponentProps, ReactNode } from 'react';
import { I18nManager, Pressable, Switch, View, useWindowDimensions } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useTheme } from '@/design';
import { ScreenList } from './Layout';
import { rowStyles } from './ListRow';
import { Text } from './Text';

type RowBase = {
  id: string;
  title: string;
  subtitle?: string;
  icon?: ComponentProps<typeof SymbolView>['name'];
  /** Decorative content only. Interactive accessories belong in their own row. */
  leading?: ReactNode;
  disabled?: boolean;
  accessibilityHint?: string;
  testID?: string;
};

export type SettingsRowData = RowBase & (
  | { kind?: 'value'; value?: string; onPress?: () => void; destructive?: boolean; onValueChange?: never }
  | { kind: 'toggle'; value: boolean; onValueChange: (value: boolean) => void; onPress?: never; destructive?: never }
);
export type SettingsSection = { id: string; title?: string; footer?: string; rows: readonly SettingsRowData[] };
export type SettingsListProps = { sections: readonly SettingsSection[]; testID?: string };

/** One scroll owner, transparent groups, and content-sized rows on every platform. */
export function SettingsList({ sections, testID }: SettingsListProps) {
  const { spacing, sizes } = useTheme();
  return <ScreenList testID={testID} data={sections} keyExtractor={section => section.id}
    contentContainerStyle={{ paddingHorizontal: sizes.gutter, paddingVertical: spacing.lg, gap: spacing.xl }}
    keyboardShouldPersistTaps="handled" renderItem={({ item }) => <SettingsGroup section={item} />} />;
}

/** Non-scrolling composition for settings embedded in a larger screen. */
export function SettingsGroup({ section }: { section: SettingsSection }) {
  const { spacing } = useTheme();
  return <View>
    {section.title && <Text variant="supporting" accessibilityRole="header" style={{ fontWeight: '500', paddingBottom: spacing.sm }}>{section.title}</Text>}
    {section.rows.map(row => <SettingsRow key={row.id} row={row} />)}
    {section.footer && <Text variant="supporting" tone="muted" style={{ paddingTop: spacing.sm }}>{section.footer}</Text>}
  </View>;
}

export function SettingsRow({ row }: { row: SettingsRowData }) {
  const { colors, sizes } = useTheme();
  const { fontScale, width } = useWindowDimensions();
  const stacked = fontScale >= 1.4 || width < 360;
  const tone = row.disabled ? 'muted' : row.destructive ? 'danger' : 'default';
  const content = <>
    {(row.leading || row.icon) && <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={rowStyles.leading}>
      {row.leading ?? <SymbolView name={row.icon!} size={sizes.icon} tintColor={row.destructive ? colors.danger : colors.text} />}
    </View>}
    <View accessibilityElementsHidden={row.kind === 'toggle'} importantForAccessibility={row.kind === 'toggle' ? 'no-hide-descendants' : 'auto'} style={rowStyles.text}>
      <Text tone={tone}>{row.title}</Text>
      {row.subtitle && <Text variant="supporting" tone="muted">{row.subtitle}</Text>}
      {stacked && row.kind !== 'toggle' && row.value !== undefined && <Text tone="muted">{row.value}</Text>}
    </View>
    {row.kind === 'toggle' ? <Switch testID={row.testID} accessibilityLabel={row.title} accessibilityHint={row.accessibilityHint ?? row.subtitle} disabled={row.disabled} value={row.value} onValueChange={value => { if (!row.disabled) row.onValueChange(value); }} /> : <>
      {!stacked && row.value !== undefined && <Text tone="muted" style={{ flexShrink: 1, maxWidth: '50%', textAlign: 'right' }}>{row.value}</Text>}
      {row.onPress && !row.destructive && <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"><SymbolView name={{ ios: I18nManager.isRTL ? 'chevron.left' : 'chevron.right', android: I18nManager.isRTL ? 'chevron_left' : 'chevron_right', web: I18nManager.isRTL ? 'chevron_left' : 'chevron_right' }} size={16} tintColor={colors.muted} /></View>}
    </>}
  </>;
  const style = rowStyles.row;
  return row.kind !== 'toggle' && row.onPress ? <Pressable testID={row.testID} onPress={row.onPress} disabled={row.disabled} accessibilityRole="button" accessibilityLabel={[row.title, row.subtitle, row.value].filter(Boolean).join(', ')} accessibilityHint={row.accessibilityHint} accessibilityState={{ disabled: !!row.disabled }} style={({ pressed }) => [style, { backgroundColor: pressed ? colors.pressed : 'transparent' }]}>{content}</Pressable> : <View testID={row.kind === 'toggle' ? undefined : row.testID} style={style}>{content}</View>;
}
