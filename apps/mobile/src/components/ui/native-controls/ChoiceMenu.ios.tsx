import { Host, HStack, Image, Menu, RNHostView, Text, Toggle } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled, font, foregroundStyle, frame } from '@expo/ui/swift-ui/modifiers';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import type { ChoiceMenuProps } from './ChoiceMenu.types';

export function ChoiceMenu({ label, selectionLabel, options, value, onChange, children, presentation = 'row' }: ChoiceMenuProps) {
  const { dark, colors, sizes, spacing } = useTheme();
  const { fontScale } = useWindowDimensions();
  const compact = presentation === 'compact';
  // A size-matching SwiftUI host keeps its embedded RN text's trait measurements.
  // Recreate it when Dynamic Type changes so shrinking text also shrinks the trigger.
  return <Host key={`${presentation}:${fontScale}:${compact ? label : ''}`} matchContents={compact ? true : { vertical: true }} style={{ alignSelf: compact ? 'flex-start' : 'stretch', maxWidth: '100%' }} colorScheme={dark ? 'dark' : 'light'} seedColor={colors.link} ignoreSafeArea="all">
    <Menu modifiers={[accessibilityLabel(label)]} label={compact ? <HStack spacing={spacing.sm} modifiers={[foregroundStyle(colors.link), font({ textStyle: 'body' }), frame({ minWidth: sizes.touch, minHeight: sizes.touch })]}><Text>{selectionLabel}</Text><Image systemName="chevron.down" /></HStack> : <RNHostView matchContents boundedByHost><>{children}</></RNHostView>}>
      {options.map(option => <Toggle key={option.value} label={option.label} isOn={option.value === value} modifiers={[disabled(!!option.disabled)]} onIsOnChange={() => { if (!option.disabled) onChange(option.value); }} />)}
    </Menu>
  </Host>;
}
