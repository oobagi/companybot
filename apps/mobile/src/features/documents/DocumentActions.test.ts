// @vitest-environment happy-dom
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useDocumentActions } from './DocumentActions';

const fixture = vi.hoisted(() => ({ discard: false, completed: vi.fn() }));
vi.mock('@/lib/useDraftGuard', () => ({ useDraftGuard: ({ dirty, onClose }: { dirty: boolean; onClose: () => void }) => ({
  dismissible: !dirty, complete: fixture.completed, dialog: null,
  close: async () => { if (!dirty || fixture.discard) onClose(); },
}) }));
vi.mock('@/lib/UnsavedWork', () => ({ useOptionalUnsavedWork: () => null }));
vi.mock('@/lib/api', () => ({ errorMessage: (error: unknown) => String(error) }));
vi.mock('@/components/ui', () => {
  const Text = ({ children }: { children: ReactNode }) => createElement('p', null, children);
  const button = ({ label, title, disabled, onPress }: { label?: string; title?: string; disabled?: boolean; onPress?: () => void }) => createElement('button', { disabled, onClick: onPress }, label ?? title);
  return {
    Text, Button: button, ListRow: button,
    ErrorState: ({ message }: { message: string }) => createElement('p', null, message),
    Field: ({ label, value, onChangeText, editable }: { label: string; value: string; onChangeText: (value: string) => void; editable: boolean }) => createElement('input', { 'aria-label': label, value, disabled: !editable, onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
    EditorSheet: ({ children, open, onClose, onDismiss, submit }: { children: ReactNode; open: boolean; onClose: () => void; onDismiss: () => void; submit?: { label?: string; disabled?: boolean; onPress: () => void } }) => {
      useEffect(() => { if (!open) onDismiss(); }, [open, onDismiss]);
      return createElement('section', null, createElement('button', { onClick: onClose }, submit ? 'Cancel' : 'Close'), submit && button({ ...submit, label: submit.label ?? 'Done' }), children);
    },
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement;
let actions: ReturnType<typeof useDocumentActions>;
function Harness({ available, create }: { available: boolean; create: (title: string) => Promise<string> }) {
  const current = useDocumentActions({ editable: true, available, canCreate: true, create });
  useEffect(() => { actions = current; }, [current]);
  return current.dialog;
}
async function setup(create = vi.fn(async () => 'child-id')) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (available: boolean) => { await act(async () => root!.render(createElement(Harness, { available, create }))); };
  await render(true);
  return { create, render };
}
const button = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label)!;
async function fill(label: string, value: string) {
  await act(async () => { const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); });
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; fixture.discard = false; fixture.completed.mockClear(); });

it('retains an interrupted link draft, rejects Done and keeps Cancel guarded', async () => {
  const { render } = await setup();
  const reply = vi.fn();
  await act(async () => { void actions.onEditLink({ url: '', text: '' }).then(reply); });
  await fill('Link', 'https://example.com/draft');
  await render(false);
  expect(host.textContent).toContain('editor closed unexpectedly');
  expect(button('Done').disabled).toBe(true);
  await act(async () => button('Done').click());
  await act(async () => button('Cancel').click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="Link"]')!.value).toBe('https://example.com/draft');
  expect(reply).not.toHaveBeenCalled();
  expect(fixture.completed).not.toHaveBeenCalled();
  fixture.discard = true;
  await act(async () => button('Cancel').click());
  expect(reply).toHaveBeenCalledWith(null);
});

it('retains an interrupted sub-page title without creating a child', async () => {
  const { render, create } = await setup();
  const reply = vi.fn();
  await act(async () => { void actions.onCreatePage().then(reply); });
  await fill('Title', 'Unsaved child');
  await render(false);
  expect(button('Create').disabled).toBe(true);
  await act(async () => button('Create').click());
  await act(async () => button('Cancel').click());
  expect(host.querySelector<HTMLInputElement>('[aria-label="Title"]')!.value).toBe('Unsaved child');
  expect(create).not.toHaveBeenCalled();
  expect(reply).not.toHaveBeenCalled();
  fixture.discard = true;
  await act(async () => button('Cancel').click());
  expect(reply).toHaveBeenCalledWith(null);
});

it('reports a child already committed during interruption and prevents duplicate creation', async () => {
  let finish!: (value: string) => void;
  const create = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const { render } = await setup(create);
  const reply = vi.fn();
  await act(async () => { void actions.onCreatePage().then(reply); });
  await fill('Title', 'Committed child');
  await act(async () => button('Create').click());
  await render(false);
  await act(async () => finish('child-id'));
  expect(host.textContent).toContain('Your sub-page was created');
  expect(button('Create')).toBeUndefined();
  expect(create).toHaveBeenCalledOnce();
  expect(reply).not.toHaveBeenCalled();
  await act(async () => button('Close').click());
  expect(reply).toHaveBeenCalledWith(null);
});

it('blocks stale block actions and new requests when the editor is unavailable', async () => {
  const { render } = await setup();
  const reply = vi.fn();
  await act(async () => { void actions.onBlockActions({ id: 'block-1', type: 'paragraph', up: true, down: true, indent: true, outdent: true }).then(reply); });
  await render(false);
  expect(button('Delete block').disabled).toBe(true);
  await act(async () => button('Delete block').click());
  expect(reply).not.toHaveBeenCalled();
  await act(async () => button('Close').click());
  expect(reply).toHaveBeenCalledWith(null);
  expect(await actions.onCreatePage()).toBeNull();
  expect(await actions.onEditLink({ url: '', text: '' })).toBeNull();
});


it('returns a committed child to a live editor after sheet dismissal', async () => {
  const { create } = await setup();
  const reply = vi.fn();
  await act(async () => { void actions.onCreatePage().then(reply); });
  await fill('Title', 'Child page');
  await act(async () => button('Create').click());
  expect(create).toHaveBeenCalledWith('Child page');
  expect(reply).toHaveBeenCalledWith('child-id');
});
