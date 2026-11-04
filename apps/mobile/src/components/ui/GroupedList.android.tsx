import { Column, Host, Icon, LazyColumn, ListItem, RNHostView, Surface, Switch, Text } from '@expo/ui/jetpack-compose';
import { fillMaxSize, padding, semantics, testID as nativeTestID, toggleable } from '@expo/ui/jetpack-compose/modifiers';
import ChevronRight from '@expo/material-symbols/chevron_right.xml';
import ChevronLeft from '@expo/material-symbols/chevron_left.xml';
import { I18nManager, View } from 'react-native';
import { useTheme } from '@/design';
import type { GroupedListProps, GroupedListRow } from './GroupedList.types';

export type { GroupedListProps, GroupedListRow, GroupedListSection } from './GroupedList.types';

/** Material ListItems keep native row sizing; LazyColumn owns the scroll viewport. */
export function GroupedList({ sections, testID }: GroupedListProps) {
  const { colors, dark, spacing } = useTheme();
  return <Host style={{ flex: 1 }} colorScheme={dark ? 'dark' : 'light'} seedColor={colors.link}>
    <LazyColumn modifiers={[fillMaxSize(), ...(testID ? [nativeTestID(testID)] : [])]} contentPadding={{ top: spacing.sm, bottom: spacing.lg }}>
      {sections.flatMap(section => [
        section.title ? <Text key={`${section.id}:title`} color={colors.muted} style={{ typography: 'labelLarge' }} modifiers={[padding(spacing.lg, spacing.lg, spacing.lg, spacing.sm)]}>{section.title}</Text> : null,
        ...section.rows.map(row => <Row key={`${section.id}:row:${row.id}`} row={row} />),
        section.footer ? <Text key={`${section.id}:footer`} color={colors.muted} style={{ typography: 'bodySmall' }} modifiers={[padding(spacing.lg, spacing.sm, spacing.lg, spacing.lg)]}>{section.footer}</Text> : null,
      ])}
    </LazyColumn>
  </Host>;
}

function Row({ row }: { row: GroupedListRow }) {
  const { colors, sizes, spacing } = useTheme();
  const titleColor = row.disabled ? colors.muted : row.destructive ? colors.danger : colors.text;
  const description = [row.title, row.subtitle, row.kind !== 'toggle' && row.value, row.accessibilityHint].filter(Boolean).join('. ');
  const rowModifiers = [...(row.testID ? [nativeTestID(row.testID)] : []), ...(row.accessibilityHint ? [semantics({ contentDescription: description })] : [])];
  const content = <ListItem colors={{ containerColor: colors.surface }} modifiers={row.kind === 'toggle' ? [...rowModifiers, toggleable(row.value, () => { if (!row.disabled) row.onValueChange(!row.value); }, { role: 'switch', enabled: !row.disabled })] : row.onPress ? undefined : rowModifiers}>
    <ListItem.HeadlineContent><Text color={titleColor} style={{ typography: 'bodyLarge' }}>{row.title}</Text></ListItem.HeadlineContent>
    {(row.subtitle || (row.kind !== 'toggle' && row.value !== undefined)) && <ListItem.SupportingContent><Column verticalArrangement={{ spacedBy: spacing.xs }}>
      {row.subtitle && <Text color={colors.muted} style={{ typography: 'bodyMedium' }}>{row.subtitle}</Text>}
      {row.kind !== 'toggle' && row.value !== undefined && <Text color={colors.muted} style={{ typography: 'bodyMedium' }}>{row.value}</Text>}
    </Column></ListItem.SupportingContent>}
    {(row.leading || row.icon?.android) && <ListItem.LeadingContent>{row.leading ? <RNHostView matchContents><View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{row.leading}</View></RNHostView> : row.icon?.android ? <Icon source={row.icon.android} tint={colors.muted} size={sizes.icon} /> : null}</ListItem.LeadingContent>}
    {row.kind === 'toggle' ? <ListItem.TrailingContent><Switch value={row.value} enabled={!row.disabled} /></ListItem.TrailingContent> : row.onPress && !row.destructive && <ListItem.TrailingContent><Icon source={I18nManager.isRTL ? ChevronLeft : ChevronRight} tint={colors.muted} size={sizes.icon} /></ListItem.TrailingContent>}
  </ListItem>;
  return row.kind !== 'toggle' && row.onPress ? <Surface modifiers={rowModifiers} color={colors.surface} enabled={!row.disabled} onClick={() => { if (!row.disabled) row.onPress?.(); }}>{content}</Surface> : content;
}
