import { useMemo } from 'react';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { savedKeys, type PinKey } from './model';

export function usePins() {
  const data = useQuery(api.arrangements.get);
  const lists = useMemo(() => savedKeys(data?.rows ?? []), [data]);
  const change = useMutation(api.arrangements.change);
  return { ...lists, loaded: data !== undefined, available: !!data, change };
}

/** Personal pins do not require sidebar.arrange, which only governs shared lists. */
export function usePinAction(key?: PinKey) {
  const { pins, loaded, available, change } = usePins();
  const task = useTask();
  const pinned = !!key && pins.includes(key);
  return {
    label: pinned ? 'Unpin' : 'Pin',
    disabled: !key || !loaded || !available || task.busy,
    error: task.error,
    onPress: () => { if (key && loaded && available) void task.run(() => change({ list: 'pins', command: { op: pinned ? 'remove' : 'add', id: key } })); },
  };
}
