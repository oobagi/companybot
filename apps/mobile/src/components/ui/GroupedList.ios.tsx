import { Button, Form, Host, HStack, Image, RNHostView, Section, Spacer, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import { accessibilityHidden, accessibilityHint, accessibilityLabel, contentShape, disabled, font, foregroundStyle, frame, shapes } from '@expo/ui/swift-ui/modifiers';
import { useWindowDimensions, View } from 'react-native';
import { useTheme } from '@/design';
import type { GroupedListProps, GroupedListRow } from './GroupedList.types';

export type { GroupedListProps, GroupedListRow, GroupedListSection } from './GroupedList.types';

/** SwiftUI owns section surfaces, row padding, scrolling and Dynamic Type. */
export function GroupedList({ sections, testID }: GroupedListProps) {
  const { colors, dark } = useTheme();
  const { fontScale } = useWindowDimensions();
  return <Host style={{ flex: 1 }} colorScheme={dark ? 'dark' : 'light'} seedColor={colors.link}>
    <Form testID={testID}>
      {sections.map(section => <Section key={section.id} title={section.title} footer={section.footer ? <Text>{section.footer}</Text> : undefined}>
        {section.rows.map(row => <Row key={row.id} row={row} fontScale={fontScale} />)}
      </Section>)}
    </Form>
  </Host>;
}

function Row({ row, fontScale }: { row: GroupedListRow; fontScale: number }) {
  const { colors, spacing, sizes } = useTheme();
  const stacked = fontScale >= 1.4;
  const titleColor = row.disabled ? colors.muted : row.destructive ? colors.danger : colors.text;
  const label = [row.title, row.subtitle, row.kind !== 'toggle' && row.value].filter(Boolean).join(', ');
  const hint = row.accessibilityHint ? [accessibilityHint(row.accessibilityHint)] : [];
  const content = <HStack testID={row.kind !== 'toggle' && !row.onPress ? row.testID : undefined} spacing={spacing.md} modifiers={[contentShape(shapes.rectangle())]}>
    {row.leading ? <RNHostView matchContents><View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{row.leading}</View></RNHostView> : row.icon?.ios ? <Image systemName={row.icon.ios} modifiers={[font({ textStyle: 'body' }), foregroundStyle(colors.muted), frame({ minWidth: sizes.icon * Math.max(1, fontScale) }), accessibilityHidden()]} /> : null}
    <VStack alignment="leading" spacing={spacing.xs} modifiers={stacked ? [frame({ maxWidth: Infinity, alignment: 'leading' })] : undefined}>
      <Text modifiers={[font({ textStyle: 'body' }), foregroundStyle(titleColor)]}>{row.title}</Text>
      {row.subtitle && <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.muted)]}>{row.subtitle}</Text>}
      {stacked && row.kind !== 'toggle' && row.value !== undefined && <Text modifiers={[font({ textStyle: 'body' }), foregroundStyle(colors.muted)]}>{row.value}</Text>}
    </VStack>
    {row.kind !== 'toggle' && <>
      {!stacked && <Spacer />}
      {!stacked && row.value !== undefined && <Text modifiers={[font({ textStyle: 'body' }), foregroundStyle(colors.muted)]}>{row.value}</Text>}
      {row.onPress && !row.destructive && <Image systemName="chevron.forward" modifiers={[font({ textStyle: 'caption', weight: 'semibold' }), foregroundStyle(colors.muted), accessibilityHidden()]} />}
    </>}
  </HStack>;
  if (row.kind === 'toggle') return <Toggle testID={row.testID} isOn={row.value} onIsOnChange={value => { if (!row.disabled) row.onValueChange(value); }} modifiers={[disabled(!!row.disabled), accessibilityLabel(label), ...hint]}>{content}</Toggle>;
  if (row.onPress) return <Button testID={row.testID} role={row.destructive ? 'destructive' : 'default'} onPress={row.disabled ? undefined : row.onPress} modifiers={[disabled(!!row.disabled), accessibilityLabel(label), ...hint]}>{content}</Button>;
  return content;
}
