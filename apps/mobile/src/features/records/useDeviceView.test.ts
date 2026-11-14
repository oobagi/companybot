// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDeviceView } from './useDeviceView';
import { deviceViewKey } from './deviceView';
import type { Database, SavedView } from './model';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } }));
const database = { _id: 'db', fields: [{ _id: 'name', key: 'name', kind: 'text', label: 'Name' }] } as Database;
const saved = (id: string, version = 1): SavedView => ({ _id: id, name: id, version, columns: ['name'], filters: [] }) as unknown as SavedView;
let root: Root;
let state: ReturnType<typeof useDeviceView>;
function Probe({ view }: { view: SavedView }) {
  const value = useDeviceView('workspace', database, 'USD', view);
  useLayoutEffect(() => { state = value; }, [value]);
  return null;
}
const show = (view: SavedView) => act(async () => root.render(createElement(Probe, { view })));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  vi.mocked(AsyncStorage.setItem).mockResolvedValue();
  vi.mocked(AsyncStorage.removeItem).mockResolvedValue();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => root.unmount()); vi.resetAllMocks(); });

it('keeps a deleted view editor’s apply/reset bound to that view without replacing the next view’s state', async () => {
  await show(saved('old'));
  const old = state;
  await show(saved('next'));
  expect(state.loaded).toBe(true);
  const changed = { ...old.config, filters: [{ field: 'name', eq: 'Acme' }] };
  await act(async () => old.set(changed));
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(deviceViewKey('workspace', 'db', 'old'), JSON.stringify({ config: changed, baseVersion: 1 }));
  expect(state.loaded).toBe(true);
  expect(state.config.filters).toEqual([]);
  await act(async () => old.reset());
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith(deviceViewKey('workspace', 'db', 'old'));
  expect(state.loaded).toBe(true);
});

it('does not rebase an applied device draft after a remote update, and reset loads current shared settings', async () => {
  await show(saved('view', 1));
  await act(async () => state.set({ ...state.config, filters: [{ field: 'name', eq: 'Local' }] }));
  await show({ ...saved('view', 2), filters: [{ field: 'name', eq: 'Remote' }] });
  expect(state.baseVersion).toBe(1);
  expect(state.config.filters).toEqual([{ field: 'name', eq: 'Local' }]);
  await act(async () => state.reset());
  expect(state.baseVersion).toBe(2);
  expect(state.local).toBe(false);
  expect(state.config.filters).toEqual([{ field: 'name', eq: 'Remote' }]);
});

it('ignores a previous view’s slow storage read after selecting another view', async () => {
  let resolveOld!: (value: string) => void;
  vi.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await show(saved('old'));
  expect(state.loaded).toBe(false);
  await show(saved('next'));
  expect(state.loaded).toBe(true);
  await act(async () => resolveOld(JSON.stringify({ config: { columns: ['name'], filters: [{ field: 'name', eq: 'Old' }] }, baseVersion: 1 })));
  expect(state.loaded).toBe(true);
  expect(state.config.filters).toEqual([]);
});
