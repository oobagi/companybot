import { useState } from 'react';
import { Host } from '@expo/ui';
import { HStack, Image, Menu, Text, Toggle, VStack } from '@expo/ui/swift-ui';
import { accessibilityLabel, buttonStyle, disabled, fixedSize, font, foregroundStyle, frame, lineLimit, multilineTextAlignment, padding } from '@expo/ui/swift-ui/modifiers';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import type { ChoiceMenuProps } from './ChoiceMenu.types';

export function ChoiceMenu({ label, selectionLabel, options, value, onChange, presentation = 'row' }: ChoiceMenuProps) {
  const { dark, colors, sizes, spacing } = useTheme();
  const { fontScale } = useWindowDimensions();
  const compact = presentation === 'compact';
  const [rowWidth, setRowWidth] = useState<number>();
  const stacked = !compact && fontScale >= 1.5;
  // SwiftUI owns both text measurement and Dynamic Type. Bridging a flex label
  // through RNHostView can preserve stale height after accessibility text changes.
  // Menu labels also need the actual host width before their wrapped height is measured.
  const text = [font({ textStyle: 'body' }), lineLimit(), fixedSize({ horizontal: false, vertical: true })];
  const selection = <Text modifiers={[...text, foregroundStyle(compact ? colors.text : colors.muted), multilineTextAlignment(compact || stacked ? 'leading' : 'trailing'), ...(compact ? [] : [frame({ maxWidth: Infinity, alignment: stacked ? 'leading' : 'trailing' })])]}>{selectionLabel}</Text>;
  const field = <Text modifiers={[...text, foregroundStyle(colors.text), multilineTextAlignment('leading')]}>{label}</Text>;
  return <Host onLayout={event => { if (!compact && event.nativeEvent.layout.width > 0) setRowWidth(event.nativeEvent.layout.width); }} matchContents={compact ? true : { vertical: true }} style={{ alignSelf: compact ? 'flex-start' : 'stretch', maxWidth: '100%' }} colorScheme={dark ? 'dark' : 'light'} seedColor={colors.primary} ignoreSafeArea="all">
    <Menu modifiers={[buttonStyle('plain'), accessibilityLabel(`${label}, ${selectionLabel}`), ...(compact ? [] : [frame({ maxWidth: Infinity })])]} label={
      <HStack spacing={spacing.sm} modifiers={[padding({ vertical: spacing.sm }), ...(!compact && rowWidth ? [frame({ width: rowWidth })] : []), frame({ minWidth: sizes.touch, minHeight: sizes.touch })]}>
        {stacked ? <VStack alignment="leading" spacing={spacing.xs} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' })]}>{field}{selection}</VStack> : <>{!compact && field}{selection}</>}
        <Image systemName="chevron.down" modifiers={[font({ textStyle: 'body' }), foregroundStyle(compact ? colors.text : colors.muted), fixedSize()]} />
      </HStack>
    }>
      {options.map(option => <Toggle key={option.value} label={option.label} isOn={option.value === value} modifiers={[disabled(!!option.disabled)]} onIsOnChange={() => { if (!option.disabled) onChange(option.value); }} />)}
    </Menu>
  </Host>;
}
