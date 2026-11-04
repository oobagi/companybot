import { Host, Menu, RNHostView, Toggle } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled } from '@expo/ui/swift-ui/modifiers';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '@/design';
import type { ChoiceMenuProps } from './ChoiceMenu.types';

export function ChoiceMenu({ label, options, value, onChange, children, presentation = 'row' }: ChoiceMenuProps) {
  const { dark, colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const compact = presentation === 'compact';
  // A size-matching SwiftUI host keeps its embedded RN text's trait measurements.
  // Recreate it when Dynamic Type changes so shrinking text also shrinks the trigger.
  return <Host key={`${presentation}:${fontScale}:${compact ? label : ''}`} matchContents={compact ? true : { vertical: true }} style={{ alignSelf: compact ? 'flex-start' : 'stretch', maxWidth: '100%' }} colorScheme={dark ? 'dark' : 'light'} seedColor={colors.link} ignoreSafeArea="all">
    <Menu modifiers={[accessibilityLabel(label)]} label={<RNHostView matchContents boundedByHost><>{children}</></RNHostView>}>
      {options.map(option => <Toggle key={option.value} label={option.label} isOn={option.value === value} modifiers={[disabled(!!option.disabled)]} onIsOnChange={() => { if (!option.disabled) onChange(option.value); }} />)}
    </Menu>
  </Host>;
}
