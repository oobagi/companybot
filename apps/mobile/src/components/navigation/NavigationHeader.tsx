import { Stack } from 'expo-router';
import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { Image, Platform, Pressable } from 'react-native';
import type { SearchBarCommands } from 'react-native-screens';
import Add from '@expo/material-symbols/add.xml';
import More from '@expo/material-symbols/more_vert.xml';
import { ActionMenu, Button, Field, Stack as Row } from '@/components/ui';
import { useTheme } from '@/design';

export type HeaderAction = { label: string; onPress: () => void; disabled?: boolean };
export type NavigationHeaderProps = {
  search?: { placeholder: string; value: string; onChange: (value: string) => void };
  action?: HeaderAction;
  menu?: HeaderAction[];
  /** Caller supplies identity and behavior; the header never reads account data. */
  leading?: HeaderAction & { image?: string | null; icon: ComponentProps<typeof Stack.Toolbar.Button>['icon'] };
};

/** Native navigation controls; product data and destinations belong to the caller. */
export function NavigationHeader({ search, action, menu = [], leading }: NavigationHeaderProps) {
  const { sizes, radii } = useTheme();
  const [failedImage, setFailedImage] = useState<string>();
  const nativeText = useRef<string | undefined>(undefined);
  const value = search?.value ?? '';
  const searching = !!search;
  const desiredText = useRef(value);
  // Native search exposes commands rather than a value prop. Sync external resets
  // without moving the cursor on each keystroke reported by the native control.
  // Router accepts an object ref. Its setter also handles the initial header
  // mount, which happens after this component's layout effect installs options.
  const [searchRef] = useState(() => {
    let handle: SearchBarCommands | null = null;
    return {
      get current() { return handle; },
      set current(next: SearchBarCommands | null) {
        handle = next;
        if (next && nativeText.current !== desiredText.current) {
          nativeText.current = desiredText.current;
          next.setText(desiredText.current);
        }
      },
    };
  });
  useLayoutEffect(() => {
    desiredText.current = value;
    if (!searching) { nativeText.current = undefined; return; }
    if (searchRef.current && nativeText.current !== value) {
      nativeText.current = value;
      searchRef.current.setText(value);
    }
  }, [searchRef, searching, value]);
  const syncSearch = () => {
    nativeText.current = desiredText.current;
    searchRef.current?.setText(desiredText.current);
  };
  const image = leading?.image;
  if (Platform.OS === 'web') return <>
    <Row horizontal style={{ flexWrap: 'wrap' }}>
      {leading && <Button label={leading.label} onPress={leading.onPress} disabled={leading.disabled} variant="ghost" />}
      {action && <Button {...action} />}
      {menu.length > 0 && <ActionMenu label="More actions" actions={menu.map((item, index) => ({ id: String(index), title: item.label, disabled: item.disabled }))} onAction={id => menu[Number(id)]?.onPress()} />}
    </Row>
    {search && <Field label={search.placeholder} value={search.value} onChangeText={search.onChange} autoCapitalize="none" />}
  </>;
  return <>
    {leading && <Stack.Toolbar placement="left">
      {image && image !== failedImage ? <Stack.Toolbar.View hidesSharedBackground>
        <Pressable accessibilityRole="button" accessibilityLabel={leading.label} accessibilityState={{ disabled: !!leading.disabled }} disabled={leading.disabled} onPress={leading.onPress} style={({ pressed }) => ({ width: sizes.touch, height: sizes.touch, alignItems: 'center', justifyContent: 'center', opacity: leading.disabled ? 0.5 : pressed ? 0.6 : 1 })}>
          <Image source={{ uri: image }} accessibilityElementsHidden importantForAccessibility="no" onError={() => setFailedImage(image)} style={{ width: sizes.avatar.sm, height: sizes.avatar.sm, borderRadius: radii.full }} />
        </Pressable>
      </Stack.Toolbar.View> : <Stack.Toolbar.Button icon={leading.icon} accessibilityLabel={leading.label} onPress={leading.onPress} disabled={leading.disabled} />}
    </Stack.Toolbar>}
    {search && <Stack.SearchBar ref={searchRef} placeholder={search.placeholder} onOpen={syncSearch} onFocus={syncSearch} onChangeText={event => { desiredText.current = nativeText.current = event.nativeEvent.text; search.onChange(event.nativeEvent.text); }} onCancelButtonPress={() => { desiredText.current = nativeText.current = ''; search.onChange(''); }} autoCapitalize="none" obscureBackground={false} hideWhenScrolling={false} placement="stacked" />}
    <Stack.Toolbar placement="right">
      {menu.length > 0 && <Stack.Toolbar.Menu icon={process.env.EXPO_OS === 'ios' ? 'ellipsis' : More} accessibilityLabel="More actions">
        {menu.map(item => <Stack.Toolbar.MenuAction key={item.label} onPress={item.onPress} disabled={item.disabled}>{item.label}</Stack.Toolbar.MenuAction>)}
      </Stack.Toolbar.Menu>}
      {action && <Stack.Toolbar.Button icon={process.env.EXPO_OS === 'ios' ? 'plus' : Add} accessibilityLabel={action.label} onPress={action.onPress} disabled={action.disabled}>{action.label}</Stack.Toolbar.Button>}
    </Stack.Toolbar>
  </>;
}
