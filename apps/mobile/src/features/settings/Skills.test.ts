// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getFunctionName, type FunctionReference, type FunctionReturnType } from 'convex/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { api } from '@/lib/api';
import Skills from './Skills';

type Skill = FunctionReturnType<typeof api.skills.list>[number];
const fixture = vi.hoisted(() => ({ skills: [] as Skill[], dirty: false, write: vi.fn(async () => {}) }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, Alert: { alert: vi.fn() } }));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ itemId: 'skill-1' }), Stack: { Screen: () => null }, router: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => true } }));
vi.mock('@/design', () => ({ useTheme: () => ({ sizes: { gutter: 20 } }) }));
vi.mock('@/lib/convex', () => ({
  useQuery: (query: FunctionReference<'query'>) => getFunctionName(query) === 'skills:list' ? fixture.skills : { access: { owner: false, permissions: [], roles: [] } },
  useMutation: () => fixture.write,
}));
vi.mock('@/lib/useTask', () => ({ useTask: () => ({ busy: false, error: undefined, clear: () => {}, run: async (job: () => Promise<unknown>) => job() }) }));
vi.mock('@/lib/useDraftGuard', () => ({ useDraftGuard: ({ dirty, onClose }: { dirty: boolean; onClose: () => void }) => { fixture.dirty = dirty; return { dismissible: !dirty, close: onClose, complete: () => {}, dialog: null }; } }));
vi.mock('@/features/chat/RichText', () => ({ RichText: ({ value }: { value: string }) => createElement('p', null, value) }));
vi.mock('@/components/navigation/NavigationHeader', () => ({ NavigationHeader: () => null }));
vi.mock('@/components/navigation/HeaderMenu', () => ({ HeaderMenu: ({ actions, onAction }: { actions: { id: string; title: string; disabled?: boolean }[]; onAction: (id: string) => void }) => actions.map(action => createElement('button', { key: action.id, disabled: action.disabled, onClick: () => onAction(action.id) }, action.title)) }));
vi.mock('@/components/ui', () => {
  const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const button = ({ label, disabled, onPress }: { label?: string; disabled?: boolean; onPress?: () => void }) => createElement('button', { disabled, onClick: onPress }, label);
  return {
    Button: button, Stack: container, Screen: container, Text: container, Section: container,
    EmptyState: ({ title }: { title: string }) => createElement('p', null, title), Loading: () => createElement('p', null, 'Loading'),
    ErrorState: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message),
    Field: ({ label, value, onChangeText, editable }: { label: string; value: string; onChangeText: (value: string) => void; editable: boolean }) => createElement('input', { 'aria-label': label, value, disabled: !editable, onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
    EditorSheet: ({ children, submit, onClose }: { children: ReactNode; submit?: { label?: string; disabled?: boolean; onPress: () => void }; onClose: () => void }) => createElement('section', null,
      createElement('button', { onClick: onClose }, submit ? 'Cancel' : 'Close'), submit && button(submit), children),
    useConfirm: () => ({ confirm: async () => false, dialog: null }),
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; fixture.write.mockClear(); });

it('browses without inputs, protects an explicit draft after permission loss, and removes inaccessible content', async () => {
  fixture.skills = [{ id: 'skill-1', name: 'Research', description: 'Research a topic.', instructions: 'Keep sources.', version: '1', installed: true, createdByName: 'Jaden', audience: 'team', canEdit: false, custom: { version: 1, updatedByName: 'Jaden', updatedAt: 0 }, trash: null }];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = () => root!.render(createElement(Skills));
  const button = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label);
  await act(async () => render());
  expect(host.textContent).toContain('Keep sources.');
  expect(host.querySelector('input')).toBeNull();
  expect(button('Edit skill')).toBeUndefined();
  fixture.skills = [{ ...fixture.skills[0], canEdit: true }];
  await act(async () => render());
  await act(async () => button('Edit skill')!.click());
  const input = host.querySelector<HTMLInputElement>('[aria-label="Name"]')!;
  await act(async () => { input.value = 'Draft name'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(button('Done')?.disabled).toBe(false);
  fixture.skills = [{ ...fixture.skills[0], canEdit: false }];
  await act(async () => render());
  expect(input.value).toBe('Draft name');
  expect(input.disabled).toBe(true);
  expect(fixture.dirty).toBe(true);
  expect(button('Done')).toBeUndefined();
  expect(fixture.write).not.toHaveBeenCalled();
  fixture.skills = [];
  await act(async () => render());
  expect(host.textContent).toContain('Skill unavailable');
  expect(host.textContent).not.toContain('Keep sources.');
  expect(host.querySelector('input')).toBeNull();
});
