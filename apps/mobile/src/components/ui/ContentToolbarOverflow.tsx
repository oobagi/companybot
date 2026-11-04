import { ActionMenu } from './ActionMenu';
import type { ContentToolbarProps } from './ContentToolbar.types';

export const toolbarDirectActionLimit = 3;

/** Shares the same validated native menu and disabled semantics as other actions. */
export function ContentToolbarOverflow({ actions, busy = false, accessibilityLabel = 'Editing actions' }: Pick<ContentToolbarProps, 'actions' | 'busy' | 'accessibilityLabel'>) {
  const overflow = actions.slice(toolbarDirectActionLimit);
  if (!overflow.length) return null;
  return <ActionMenu label={`More ${accessibilityLabel.toLocaleLowerCase()}`} actions={overflow.map(action => ({
    id: action.id,
    title: action.label,
    icon: process.env.EXPO_OS === 'ios' ? action.icon.ios : action.icon.android,
    disabled: busy || action.disabled,
  }))} onAction={id => {
    const action = overflow.find(item => item.id === id);
    if (!busy && action && !action.disabled) action.onPress();
  }} />;
}
