// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Database, TypeField } from './model';
import { FieldForm } from './DatabaseForms';

const fixture = vi.hoisted(() => ({ types: [] as Database[], write: vi.fn(async () => {}), dirty: false }));
vi.mock('expo-router', () => ({ router: {} }));
vi.mock('@/lib/convex', () => ({ useQuery: () => fixture.types, useMutation: () => fixture.write }));
vi.mock('@/lib/useTask', () => ({ useTask: () => ({ busy: false, error: undefined, clear: () => {}, run: async (job: () => Promise<unknown>) => job() }) }));
vi.mock('@/lib/useDraftGuard', () => ({ useDraftGuard: ({ dirty, onClose }: { dirty: boolean; onClose: () => void }) => {
  fixture.dirty = dirty;
  return { dismissible: !dirty, close: onClose, complete: () => {}, dialog: null };
} }));
vi.mock('@/components/ui', () => {
  const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const button = ({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress?: () => void }) => createElement('button', { disabled, onClick: onPress }, label);
  return {
    Button: button, Stack: container, Text: container,
    ChoicePicker: () => null,
    ErrorState: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message),
    Field: ({ label, value, onChangeText, editable }: { label: string; value: string; onChangeText: (value: string) => void; editable: boolean }) => createElement('input', { 'aria-label': label, value, disabled: !editable, onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
    EditorSheet: ({ children, submit }: { children: ReactNode; submit: { label: string; disabled?: boolean; onPress: () => void } }) => createElement('section', null, button(submit), children),
    useConfirm: () => ({ confirm: async () => false, dialog: null }),
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; fixture.write.mockClear(); });
const field = { _id: 'field-1', key: 'status', label: 'Status', kind: 'choice', options: [{ id: 'open', label: 'Open' }], canEdit: true } satisfies TypeField;
const database = { _id: 'database-1', name: 'Project', plural: 'Projects', canManage: true, fields: [field] } as unknown as Database;
async function mount() {
  fixture.types = [database];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = () => root!.render(createElement(FieldForm, { database, field, onClose: () => {} }));
  await act(async () => render());
  return render;
}
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
async function type(label: string, value: string) {
  await act(async () => { const target = input(label); target.value = value; target.dispatchEvent(new Event('input', { bubbles: true })); });
}

it('blocks stale option replacement until an explicit reload, retaining the local draft', async () => {
  const render = await mount();
  await type('Label', 'Local name');
  fixture.types = [{ ...database, fields: [{ ...database.fields[0]!, options: [...field.options, { id: 'closed', label: 'Closed' }] }] }];
  await act(async () => render());
  expect(input('Label').value).toBe('Local name');
  expect(fixture.dirty).toBe(true);
  expect(button('Done').disabled).toBe(true);
  await act(async () => button('Done').click());
  expect(fixture.write).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('field changed');
  await act(async () => button('Reload latest').click());
  expect(input('Label').value).toBe('Status');
  expect(input('Option 2').value).toBe('Closed');
  expect(fixture.dirty).toBe(false);
  await type('Label', 'New name');
  await act(async () => button('Done').click());
  expect(fixture.write).toHaveBeenCalledWith({ fieldId: field._id, label: 'New name', options: [{ id: 'open', label: 'Open' }, { id: 'closed', label: 'Closed' }], position: undefined });
});

it('keeps drafts without allowing saves after management access loss or during conversion', async () => {
  const render = await mount();
  await type('Label', 'Local name');
  fixture.types = [{ ...database, canManage: false, fields: [{ ...database.fields[0]!, canEdit: false }] }];
  await act(async () => render());
  expect(input('Label').value).toBe('Local name');
  expect(input('Label').disabled).toBe(true);
  expect(button('Done').disabled).toBe(true);
  expect(fixture.dirty).toBe(true);
  fixture.types = [{ ...database, fields: [{ ...database.fields[0]!, changing: true }] }];
  await act(async () => render());
  expect(button('Done').disabled).toBe(true);
  expect(input('Label').value).toBe('Local name');
  expect(host.textContent).toContain('converting');
  expect(fixture.write).not.toHaveBeenCalled();
});
