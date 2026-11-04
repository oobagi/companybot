import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import More from '@expo/material-symbols/more_vert.xml';
import Info from '@expo/material-symbols/info.xml';
import Edit from '@expo/material-symbols/edit_square.xml';
import Chats from '@expo/material-symbols/forum.xml';
import { ActionMenu, type Action } from '@/components/ui/ActionMenu';

const androidIcons = { 'info.circle': Info, 'square.and.pencil': Edit, 'bubble.left.and.bubble.right': Chats };

/** Native navigation-bar items retain the system hit area, symbols and menu presentation. */
export function HeaderMenu({ label, actions, onAction }: { label: string; actions: Action[]; onAction: (id: string) => void }) {
  if (Platform.OS === 'web') return <ActionMenu label={label} actions={actions} onAction={onAction} />;
  const render = (items: Action[]): React.ReactNode => items.map(action => {
    const icon = process.env.EXPO_OS === 'ios' ? action.icon : action.icon && androidIcons[action.icon as keyof typeof androidIcons];
    return action.items
      ? <Stack.Toolbar.Menu key={action.id} title={action.title} icon={icon} disabled={action.disabled} destructive={action.destructive}>{render(action.items)}</Stack.Toolbar.Menu>
      : <Stack.Toolbar.MenuAction key={action.id} icon={icon} disabled={action.disabled} destructive={action.destructive} isOn={action.selected} onPress={() => onAction(action.id)}>{action.title}</Stack.Toolbar.MenuAction>;
  });
  return <Stack.Toolbar placement="right"><Stack.Toolbar.Menu icon={process.env.EXPO_OS === 'ios' ? 'ellipsis' : More} accessibilityLabel={label}>{render(actions)}</Stack.Toolbar.Menu></Stack.Toolbar>;
}
