import { Stack, router } from 'expo-router';
import { useState } from 'react';
import { Image, Platform, Pressable } from 'react-native';
import Add from '@expo/material-symbols/add.xml';
import More from '@expo/material-symbols/more_vert.xml';
import Workspace from '@expo/material-symbols/domain.xml';
import { Button, Field, Stack as Row } from '@/components/ui';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { useTheme } from '@/design';

type Action = { label: string; onPress: () => void; disabled?: boolean };

/** Keep creation and secondary actions in system chrome, leaving content for the work. */
export function DirectoryHeader({ search, action, menu = [], workspaceSwitcher = true }: {
  search?: { placeholder: string; value: string; onChange: (value: string) => void };
  action?: Action;
  menu?: Action[];
  workspaceSwitcher?: boolean;
}) {
  const me = useQuery(api.workspace.me);
  const workspace = me?.workspace ?? 'Companybot';
  const { sizes, radii } = useTheme();
  const [failedImage, setFailedImage] = useState<string>();
  const workspaceImage = me?.workspaceImage;
  const switchLabel = `Switch workspace, ${workspace}`;
  const actions = workspaceSwitcher ? [...menu, { label: 'Pinned and recent', onPress: () => router.push('/saved') }, ...(__DEV__ ? [{ label: 'Components', onPress: () => router.push('/components') }] : [])] : menu;
  if (Platform.OS === 'web') return <>
    {workspaceSwitcher && <Button label={workspace} variant="ghost" onPress={() => router.push('/workspaces')} />}
    {search && <Field label={search.placeholder} value={search.value} onChangeText={search.onChange} />}
    <Row horizontal>{action && <Button label={action.label} onPress={action.onPress} disabled={action.disabled} />}{actions.map(item => <Button key={item.label} label={item.label} variant="ghost" onPress={item.onPress} disabled={item.disabled} />)}</Row>
  </>;
  return <>
    {workspaceSwitcher && <Stack.Toolbar placement="left">
      {workspaceImage && workspaceImage !== failedImage ? <Stack.Toolbar.View hidesSharedBackground>
        <Pressable accessibilityRole="button" accessibilityLabel={switchLabel} onPress={() => router.push('/workspaces')} style={({ pressed }) => ({ width: sizes.touch, height: sizes.touch, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}>
          <Image source={{ uri: workspaceImage }} accessibilityElementsHidden importantForAccessibility="no" onError={() => setFailedImage(workspaceImage)} style={{ width: sizes.avatar.sm, height: sizes.avatar.sm, borderRadius: radii.full }} />
        </Pressable>
      </Stack.Toolbar.View> : <Stack.Toolbar.Button icon={process.env.EXPO_OS === 'ios' ? 'building.2' : Workspace} accessibilityLabel={switchLabel} onPress={() => router.push('/workspaces')} />}
    </Stack.Toolbar>}
    {search && <Stack.SearchBar placeholder={search.placeholder} onChangeText={event => search.onChange(event.nativeEvent.text)} onCancelButtonPress={() => search.onChange('')} autoCapitalize="none" obscureBackground={false} hideWhenScrolling={false} placement="stacked" />}
    <Stack.Toolbar placement="right">
      {actions.length > 0 && <Stack.Toolbar.Menu icon={process.env.EXPO_OS === 'ios' ? 'ellipsis' : More} accessibilityLabel="More actions">
        {actions.map(item => <Stack.Toolbar.MenuAction key={item.label} onPress={item.onPress} disabled={item.disabled}>{item.label}</Stack.Toolbar.MenuAction>)}
      </Stack.Toolbar.Menu>}
      {action && <Stack.Toolbar.Button icon={process.env.EXPO_OS === 'ios' ? 'plus' : Add} accessibilityLabel={action.label} onPress={action.onPress} disabled={action.disabled}>{action.label}</Stack.Toolbar.Button>}
    </Stack.Toolbar>
  </>;
}
