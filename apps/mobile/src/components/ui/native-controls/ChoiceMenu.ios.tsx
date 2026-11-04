import { Host, Menu, RNHostView, Toggle } from '@expo/ui/swift-ui';
import { accessibilityLabel, disabled } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '@/design';
import type { ChoiceMenuProps } from './ChoiceMenu.types';

export function ChoiceMenu({ label, options, value, onChange, children }: ChoiceMenuProps) {
  const { dark, colors } = useTheme();
  return <Host matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }} colorScheme={dark ? 'dark' : 'light'} seedColor={colors.link} ignoreSafeArea="all">
    <Menu modifiers={[accessibilityLabel(label)]} label={<RNHostView matchContents boundedByHost><>{children}</></RNHostView>}>
      {options.map(option => <Toggle key={option.value} label={option.label} isOn={option.value === value} modifiers={[disabled(!!option.disabled)]} onIsOnChange={() => { if (!option.disabled) onChange(option.value); }} />)}
    </Menu>
  </Host>;
}
