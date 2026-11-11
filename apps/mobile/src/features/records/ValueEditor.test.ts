// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ValueForm } from './ValueEditor';
import type { TypeField } from './model';

const fixture = vi.hoisted(() => ({ dirty: false }));
vi.mock('@/lib/convex', () => ({ useQuery: () => ({ currency: 'USD' }) }));
vi.mock('@/lib/useTask', () => ({ useTask: () => ({ busy: false, run: async (job: () => Promise<unknown>) => job() }) }));
vi.mock('@/lib/useDraftGuard', () => ({ useDraftGuard: ({ dirty, onClose }: { dirty: boolean; onClose: () => void }) => { fixture.dirty = dirty; return { dismissible: !dirty, close: onClose, complete: () => {}, dialog: null }; } }));
vi.mock('@/components/ui/native-controls/DateInput', () => ({ DateInput: () => null }));
vi.mock('@/components/ui', () => {
  const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const button = ({ label, disabled, onPress }: { label?: string; disabled?: boolean; onPress?: () => void }) => createElement('button', { disabled, onClick: onPress }, label);
  return {
    Button: button, Stack: container, Text: container,
    ErrorState: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message),
    Field: ({ label, value, onChangeText, editable }: { label: string; value: string; onChangeText: (value: string) => void; editable: boolean }) => createElement('input', { 'aria-label': label, value, disabled: !editable, onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
    ChoicePicker: ({ value, disabled }: { value: string; disabled: boolean }) => createElement('input', { value, disabled, readOnly: true }),
    EditorSheet: ({ children, submit }: { children: ReactNode; submit: { disabled?: boolean; onPress: () => void } }) => createElement('section', null, button({ ...submit, label: 'Done' }), children),
  };
});
vi.mock('@/components/ui/EditorSheet', async () => {
  const ui = await import('@/components/ui');
  return { EditorSheet: ui.EditorSheet, ChoicePicker: ui.ChoicePicker };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; });
const button = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label)!;
function mount() { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }

it('stages clearing until Done and can undo clear without losing the typed draft', async () => {
  mount();
  const save = vi.fn(async () => {});
  const field: TypeField = { _id: 'field-1', key: 'notes', label: 'Notes', kind: 'text' };
  await act(async () => root!.render(createElement(ValueForm, { field, value: 'Original', refs: {}, onSave: save, onClose: () => {} })));
  const input = host.querySelector('input')!;
  await act(async () => { input.value = 'Local draft'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('Clear value').click());
  expect(save).not.toHaveBeenCalled();
  expect(fixture.dirty).toBe(true);
  await act(async () => button('Undo clear').click());
  expect(host.querySelector('input')?.value).toBe('Local draft');
  await act(async () => button('Clear value').click());
  await act(async () => button('Done').click());
  expect(save).toHaveBeenCalledExactlyOnceWith(null);
});

it('retains the draft and blocks saving after permission loss or a live field schema change', async () => {
  mount();
  const save = vi.fn(async () => {});
  let field: TypeField = { _id: 'field-1', key: 'notes', label: 'Notes', kind: 'text' };
  let disabledReason: string | undefined;
  const render = () => root!.render(createElement(ValueForm, { field, value: 'Original', refs: {}, disabledReason, onSave: save, onClose: () => {} }));
  await act(async () => render());
  const input = host.querySelector('input')!;
  await act(async () => { input.value = 'Local draft'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  disabledReason = 'You can no longer edit this record.';
  await act(async () => render());
  expect(input.value).toBe('Local draft');
  expect(input.disabled).toBe(true);
  expect(button('Done').disabled).toBe(true);
  expect(fixture.dirty).toBe(true);
  disabledReason = undefined;
  field = { ...field, kind: 'number' };
  await act(async () => render());
  expect(input.value).toBe('Local draft');
  expect(button('Done').disabled).toBe(true);
  expect(host.textContent).toContain('This field changed elsewhere');
  expect(save).not.toHaveBeenCalled();
});
