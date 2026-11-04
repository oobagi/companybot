import type { Action } from './ActionMenu';

/** Native menus can stay open while permissions, busy state, or their items change. */
export function dispatchMenuAction(actions: readonly Action[], id: string, invoke: (id: string) => void): boolean {
  const available = (items: readonly Action[], blocked = false): boolean => items.some(action => {
    const disabled = blocked || !!action.disabled;
    if (action.items) return available(action.items, disabled);
    return action.id === id && !disabled;
  });
  if (!available(actions)) return false;
  invoke(id);
  return true;
}
