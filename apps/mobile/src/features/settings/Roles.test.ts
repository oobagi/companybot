// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { Roles, type WorkspaceRole } from './Roles';

const fixture = vi.hoisted(() => ({ roles: [] as WorkspaceRole[], owner: true, write: vi.fn(async () => {}) }));
vi.mock('@/lib/convex', () => ({
  useQuery: (query: FunctionReference<'query'>) => getFunctionName(query) === 'roles:list' ? fixture.roles : { access: { owner: fixture.owner, permissions: [], roles: [] } },
  useMutation: () => fixture.write,
}));
vi.mock('@/lib/useTask', () => ({ useTask: () => ({ busy: false, error: undefined, clear: () => {}, run: async (job: () => Promise<unknown>) => job() }) }));
vi.mock('@/lib/useDraftGuard', () => ({ useDraftGuard: ({ dirty, onClose }: { dirty: boolean; onClose: () => void }) => ({ dismissible: !dirty, close: onClose, dialog: null }) }));
vi.mock('@/components/ui', () => {
  const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const button = ({ label, title, disabled, onPress }: { label?: string; title?: string; disabled?: boolean; onPress?: () => void }) => createElement('button', { disabled, onClick: onPress }, label ?? title);
  return {
    Button: button, ListRow: button, Stack: container, Text: container, Section: container,
    SettingsRow: ({ row }: { row: { title: string; disabled?: boolean } }) => createElement('span', null, row.title),
    EmptyState: ({ title }: { title: string }) => createElement('p', null, title), Loading: () => createElement('p', null, 'Loading'),
    ErrorState: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message),
    Field: ({ label, value, onChangeText, editable }: { label: string; value: string; onChangeText: (value: string) => void; editable: boolean }) => createElement('input', { 'aria-label': label, value, disabled: !editable, onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
    EditorSheet: ({ title, children, submit, onClose }: { title: string; children: ReactNode; submit?: { label?: string; disabled?: boolean; onPress: () => void }; onClose: () => void }) => createElement('section', null,
      createElement('h1', null, title), createElement('button', { onClick: onClose }, submit ? 'Cancel' : 'Close'),
      submit && button({ ...submit, label: submit.label ?? 'Done' }), children),
    useConfirm: () => ({ confirm: async () => false, dialog: null }),
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; fixture.write.mockClear(); });

it('keeps a deliberate rename draft after a live role rename and requires reload before saving', async () => {
  fixture.owner = true;
  fixture.roles = [{ id: 'role-1' as Id<'roles'>, name: 'Crew', builtIn: null, permissions: [], people: 2, invited: 0 }];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = () => root!.render(createElement(Roles, { onClose: () => {} }));
  const button = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label)!;
  await act(async () => render());
  await act(async () => button('Crew').click());
  expect(host.querySelector('input')).toBeNull();
  await act(async () => button('Rename role').click());
  const input = host.querySelector('input')!;
  await act(async () => { input.value = 'Field crew'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(button('Done').disabled).toBe(false);
  fixture.roles = [{ ...fixture.roles[0], name: 'Remote crew' }];
  await act(async () => render());
  expect(input.value).toBe('Field crew');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('renamed while you were editing');
  expect(button('Done').disabled).toBe(true);
  expect(fixture.write).not.toHaveBeenCalled();
  await act(async () => button('Reload name').click());
  expect(input.value).toBe('Remote crew');
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { input.value = 'New name'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  fixture.owner = false;
  await act(async () => render());
  expect(button('Done').disabled).toBe(true);
  expect(input.disabled).toBe(true);
  expect(input.value).toBe('New name');
});
