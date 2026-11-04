import { MenuView, type MenuComponentRef } from '@expo/ui/community/menu';
import { useRef } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/design';
import type { ChoiceMenuProps } from './ChoiceMenu.types';

export function ChoiceMenu({ label, options, value, onChange, children }: ChoiceMenuProps) {
  const ref = useRef<MenuComponentRef>(null);
  const { dark } = useTheme();
  return <MenuView ref={ref} colorScheme={dark ? 'dark' : 'light'} style={{ alignSelf: 'stretch' }} actions={options.map(option => ({ id: option.value, title: option.label, state: option.value === value ? 'on' : 'off', attributes: { disabled: option.disabled } }))}
    onPressAction={({ nativeEvent }) => { const option = options.find(o => o.value === nativeEvent.event); if (option && !option.disabled) onChange(option.value); }}>
    <View accessible accessibilityRole="button" accessibilityLabel={label} accessibilityActions={[{ name: 'activate' }]} onAccessibilityAction={() => ref.current?.show()}>{children}</View>
  </MenuView>;
}
