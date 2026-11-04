import { MenuView, type MenuAction } from '@expo/ui/community/menu';
import { SymbolView } from 'expo-symbols';
import { useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { Button } from './Button';
import { EditorSheet } from './EditorSheet';
import { Stack } from './Layout';
import { Text } from './Text';
import { useTheme } from '@/design';
import { menuIcon } from './menuIcon';

export type Action = { id: string; title: string; icon?: MenuAction['image']; destructive?: boolean; disabled?: boolean; selected?: boolean; items?: Action[] };
const nativeActions = (actions: Action[]): MenuAction[] => actions.map(action => ({ id: action.id, title: action.title, image: menuIcon(action.icon), attributes: { destructive: action.destructive, disabled: action.disabled }, state: action.selected === undefined ? undefined : action.selected ? 'on' : 'off', subactions: action.items ? nativeActions(action.items) : undefined }));

/** A tap menu with platform-native presentation; never wraps interactive message content. */
export function ActionMenu({ label, actions, onAction, children }: { label: string; actions: Action[]; onAction: (id: string) => void; children?: ReactNode }) {
  const { colors, sizes, spacing } = useTheme();
  const [open, setOpen] = useState(false);
  if (Platform.OS !== 'web') return <MenuView title={label} actions={nativeActions(actions)} onPressAction={event => onAction(event.nativeEvent.event)}>
    <View accessible accessibilityRole="button" accessibilityLabel={label} style={{ minWidth: sizes.touch, minHeight: sizes.touch, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm }}>{children ?? <SymbolView name={{ ios: 'ellipsis', android: 'more_horiz' }} size={sizes.icon} tintColor={colors.muted} />}</View>
  </MenuView>;
  const render = (items: Action[]): ReactNode => items.map(action => action.items ? <Stack key={action.id}><Text variant="label">{action.title}</Text>{render(action.items)}</Stack> : <Button key={action.id} label={`${action.selected ? '✓ ' : ''}${action.title}`} disabled={action.disabled} variant={action.destructive ? 'danger' : 'ghost'} onPress={() => { setOpen(false); onAction(action.id); }} />);
  return <><Button label={label} variant="ghost" onPress={() => setOpen(true)} />{open && <EditorSheet title={label} onClose={() => setOpen(false)}>{render(actions)}</EditorSheet>}</>;
}
