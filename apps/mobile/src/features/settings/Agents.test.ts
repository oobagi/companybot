// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { afterEach, expect, it, vi } from 'vitest';
import Agents from './Agents';

const state = vi.hoisted(() => ({
  itemId: undefined as string | undefined,
  owner: true,
  agent: { _id: 'agent-1', name: 'Companybot', description: 'A teammate', instructions: 'Help the team.', model: 'test-model', reasoning: 'medium', tools: ['memory.*'], version: 1, archived: false, updatedByName: 'Jaden', updatedAt: 0 },
  push: vi.fn(), write: vi.fn(async () => {}), guards: [] as { dirty: boolean }[],
}));
vi.mock('expo-router', () => ({
  router: { push: state.push },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ itemId: state.itemId }),
}));
vi.mock('@/design', () => ({ useTheme: () => ({ sizes: { gutter: 20 } }) }));
vi.mock('@/lib/convex', () => ({
  useQuery: (query: FunctionReference<'query'>) => {
    const name = getFunctionName(query);
    if (name === 'agents:list') return [state.agent];
    if (name === 'agents:options') return { models: [{ id: 'test-model', name: 'Test model' }], groups: [] };
    if (name === 'agents:history') return [];
    return { access: { owner: state.owner, permissions: [], roles: [] } };
  },
  useMutation: () => state.write,
}));
vi.mock('@/lib/useTask', () => ({ useTask: () => ({ busy: false, error: undefined, clear: () => {}, run: async (job: () => Promise<unknown>) => job() }) }));
vi.mock('@/lib/useDraftGuard', () => ({ useDraftGuard: (options: { dirty: boolean; onClose: () => void }) => {
  state.guards.push({ dirty: options.dirty });
  return { dismissible: !options.dirty, close: options.onClose, complete: () => {}, dialog: null };
} }));
vi.mock('@/components/navigation/NavigationHeader', () => ({ NavigationHeader: () => null }));
vi.mock('@/components/navigation/HeaderMenu', () => ({ HeaderMenu: ({ actions, onAction }: { actions: { id: string; title: string; disabled?: boolean }[]; onAction: (id: string) => void }) => createElement('nav', null, actions.map(action => createElement('button', { key: action.id, disabled: action.disabled, onClick: () => onAction(action.id) }, action.title))) }));
vi.mock('./customize/ImageControl', () => ({ ImageControl: () => null }));
vi.mock('@/components/ui', () => {
  const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const button = ({ label, title, disabled, onPress }: { label?: string; title?: string; disabled?: boolean; onPress?: () => void }) => createElement('button', { disabled, onClick: onPress }, label ?? title);
  return {
    Avatar: () => null, Divider: () => null, Button: button, ListRow: button,
    Stack: container, Text: container, Section: container, Screen: container,
    SettingsRow: () => null, ChoicePicker: () => null,
    ScreenList: ({ data, renderItem }: { data: unknown[]; renderItem: (args: { item: unknown }) => ReactNode }) => createElement('div', null, data.map((item, index) => createElement('div', { key: index }, renderItem({ item })))),
    EmptyState: ({ title }: { title: string }) => createElement('p', null, title), Loading: () => createElement('p', null, 'Loading'),
    ErrorState: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message),
    Field: ({ label, value, onChangeText, editable }: { label: string; value: string; onChangeText: (value: string) => void; editable: boolean }) => createElement('input', { 'aria-label': label, value, disabled: !editable, onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
    EditorSheet: ({ children, submit, onClose }: { children: ReactNode; submit?: { disabled?: boolean; onPress: () => void }; onClose: () => void }) => createElement('section', null,
      createElement('button', { onClick: onClose }, 'Cancel'), submit && button({ ...submit, label: 'Done' }), children),
    useConfirm: () => ({ confirm: async () => false, dialog: null }),
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; state.write.mockClear(); state.push.mockClear(); state.guards = []; });

it('opens details before editing and keeps a conflicting draft when management permission is lost', async () => {
  state.itemId = undefined; state.owner = true; state.agent = { ...state.agent, name: 'Companybot', version: 1 };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = () => root!.render(createElement(Agents));
  const button = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label)!;
  await act(async () => render());
  expect(host.querySelector('input')).toBeNull();
  await act(async () => button('Companybot').click());
  expect(state.push).toHaveBeenCalledWith({ pathname: '/settings/[section]', params: { section: 'agents', itemId: 'agent-1' } });
  state.itemId = 'agent-1';
  await act(async () => render());
  expect(host.querySelector('input')).toBeNull();
  await act(async () => button('Edit agent').click());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  await act(async () => { input.value = 'My teammate'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(button('Done').disabled).toBe(false);
  expect(button('Archive agent').disabled).toBe(true);
  state.agent = { ...state.agent, name: 'Remote teammate', version: 2 };
  await act(async () => render());
  expect(input.value).toBe('My teammate');
  expect(button('Done').disabled).toBe(true);
  expect(button('Reload latest')).toBeDefined();
  state.owner = false;
  await act(async () => render());
  expect(input.value).toBe('My teammate');
  expect(input.disabled).toBe(true);
  expect(state.guards.at(-1)?.dirty).toBe(true);
  expect(state.write).not.toHaveBeenCalled();
});
