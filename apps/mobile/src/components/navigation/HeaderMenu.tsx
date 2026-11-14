import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import More from '@expo/material-symbols/more_vert.xml';
import { ActionMenu, type Action } from '@/components/ui/ActionMenu';
import { menuIcon } from '@/components/ui/menuIcon';

/** Native navigation-bar items retain the system hit area, symbols and menu presentation. */
export function HeaderMenu({ label, actions, onAction }: { label: string; actions: Action[]; onAction: (id: string) => void }) {
  if (Platform.OS === 'web') return <ActionMenu label={label} actions={actions} onAction={onAction} />;
  const render = (items: Action[]): React.ReactNode => items.map(action => {
    const icon = menuIcon(action.icon);
    return action.items
      ? <Stack.Toolbar.Menu key={action.id} title={action.title} icon={icon} disabled={action.disabled} destructive={action.destructive}>{render(action.items)}</Stack.Toolbar.Menu>
      : <Stack.Toolbar.MenuAction key={action.id} icon={icon} disabled={action.disabled} destructive={action.destructive} isOn={action.selected} onPress={() => onAction(action.id)}>{action.title}</Stack.Toolbar.MenuAction>;
  });
  return <Stack.Toolbar placement="right"><Stack.Toolbar.Menu icon={process.env.EXPO_OS === 'ios' ? 'ellipsis' : More} accessibilityLabel={label}>{render(actions)}</Stack.Toolbar.Menu></Stack.Toolbar>;
}
