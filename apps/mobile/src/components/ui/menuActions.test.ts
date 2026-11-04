import { describe, expect, it, vi } from 'vitest';
import type { Action } from './ActionMenu';
import { dispatchMenuAction } from './menuActions';

describe('menu action delivery', () => {
  it('rejects a selection delivered after an action is disabled or removed', () => {
    let current: Action[] = [{ id: 'archive', title: 'Archive' }];
    const invoke = vi.fn();
    // A native menu holds its displayed items until dismissal, but delivery must
    // consult the current React tree, not the tree that opened it.
    const deliver = () => dispatchMenuAction(current, 'archive', invoke);
    current = [{ id: 'archive', title: 'Archive', disabled: true }];
    expect(deliver()).toBe(false);
    current = [];
    expect(deliver()).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    current = [{ id: 'archive', title: 'Archive' }];
    expect(deliver()).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('archive');
  });

  it('respects disabled ancestor menus while keeping independent actions usable', () => {
    const actions: Action[] = [
      { id: 'manage', title: 'Manage', disabled: true, items: [{ id: 'people', title: 'People', items: [{ id: 'remove', title: 'Remove person' }] }] },
      { id: 'view', title: 'View', items: [{ id: 'details', title: 'Details' }] },
    ];
    const invoke = vi.fn();
    expect(dispatchMenuAction(actions, 'remove', invoke)).toBe(false);
    expect(dispatchMenuAction(actions, 'view', invoke)).toBe(false);
    expect(dispatchMenuAction(actions, 'missing', invoke)).toBe(false);
    expect(dispatchMenuAction(actions, 'details', invoke)).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('details');
  });
});
