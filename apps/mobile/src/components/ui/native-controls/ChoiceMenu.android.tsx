import { MenuView, type MenuComponentRef } from '@expo/ui/community/menu';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/design';
import type { ChoiceMenuProps } from './ChoiceMenu.types';

export function ChoiceMenu({ label, options, value, onChange, children, presentation = 'row' }: ChoiceMenuProps) {
  const ref = useRef<MenuComponentRef>(null);
  const [width, setWidth] = useState<number>();
  const { dark } = useTheme();
  const row = presentation === 'row';
  return <View style={{ alignSelf: row ? 'stretch' : 'flex-start', maxWidth: '100%' }} onLayout={event => { if (row) setWidth(event.nativeEvent.layout.width); }}><MenuView ref={ref} colorScheme={dark ? 'dark' : 'light'} style={{ alignSelf: row ? 'stretch' : 'flex-start', maxWidth: '100%' }} actions={options.map(option => ({ id: option.value, title: option.label, state: option.value === value ? 'on' : 'off', attributes: { disabled: option.disabled } }))}
    onPressAction={({ nativeEvent }) => { const option = options.find(o => o.value === nativeEvent.event); if (option && !option.disabled) onChange(option.value); }}>
    <View style={{ width: row ? width : undefined }} accessible accessibilityRole="button" accessibilityLabel={label} accessibilityActions={[{ name: 'activate' }]} onAccessibilityAction={() => ref.current?.show()}>{children}</View>
  </MenuView></View>;
}
