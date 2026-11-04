import { Fragment } from 'react';
import { I18nManager, Pressable, ScrollView, Switch, useWindowDimensions, View } from 'react-native';
import { CaretLeft, CaretRight } from 'phosphor-react-native';
import { useTheme } from '@/design';
import { Text } from './Text';
import type { GroupedListProps, GroupedListRow } from './GroupedList.types';

export type { GroupedListProps, GroupedListRow, GroupedListSection } from './GroupedList.types';

/** Web fallback; native platforms resolve to Form or Compose LazyColumn. */
export function GroupedList({ sections, testID }: GroupedListProps) {
  const { colors, spacing, radii } = useTheme();
  const { fontScale } = useWindowDimensions();
  return <ScrollView testID={testID} style={{ flex: 1 }} contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }} keyboardShouldPersistTaps="handled">
    {sections.map(section => <View key={section.id} style={{ gap: spacing.sm }}>
      {section.title && <Text variant="caption" tone="muted" accessibilityRole="header">{section.title}</Text>}
      <View style={{ backgroundColor: colors.surface, borderRadius: radii.lg, overflow: 'hidden' }}>
        {section.rows.map((row, index) => <Fragment key={row.id}>{index > 0 && <View style={{ height: 1, backgroundColor: colors.border, marginHorizontal: spacing.lg }} />}<Row row={row} stacked={fontScale >= 1.4} /></Fragment>)}
      </View>
      {section.footer && <Text variant="caption" tone="muted">{section.footer}</Text>}
    </View>)}
  </ScrollView>;
}

function Row({ row, stacked }: { row: GroupedListRow; stacked: boolean }) {
  const { colors, sizes, spacing } = useTheme();
  const Caret = I18nManager.isRTL ? CaretLeft : CaretRight;
  const content = <>
    {row.leading && <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{row.leading}</View>}
    <View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}><Text tone={row.disabled ? 'muted' : row.destructive ? 'danger' : 'default'}>{row.title}</Text>{row.subtitle && <Text variant="caption" tone="muted">{row.subtitle}</Text>}{stacked && row.kind !== 'toggle' && row.value !== undefined && <Text tone="muted">{row.value}</Text>}</View>
    {row.kind === 'toggle' ? <Switch testID={row.testID} accessibilityLabel={row.title} accessibilityHint={row.accessibilityHint ?? row.subtitle} value={row.value} disabled={row.disabled} onValueChange={value => { if (!row.disabled) row.onValueChange(value); }} /> : <>
      {!stacked && row.value !== undefined && <Text tone="muted" style={{ flexShrink: 1, textAlign: 'right' }}>{row.value}</Text>}
      {row.onPress && !row.destructive && <Caret size={sizes.icon} color={colors.muted} aria-hidden />}
    </>}
  </>;
  const style = { minHeight: sizes.touch, flexDirection: 'row' as const, alignItems: 'center' as const, padding: spacing.lg, gap: spacing.md };
  return row.kind !== 'toggle' && row.onPress ? <Pressable testID={row.testID} accessibilityRole="button" accessibilityLabel={[row.title, row.subtitle, row.value].filter(Boolean).join(', ')} accessibilityHint={row.accessibilityHint} accessibilityState={{ disabled: !!row.disabled }} disabled={row.disabled} onPress={row.onPress} style={({ pressed }) => [style, { backgroundColor: pressed ? colors.pressed : 'transparent' }]}>{content}</Pressable> : <View testID={row.kind !== 'toggle' ? row.testID : undefined} style={style}>{content}</View>;
}
