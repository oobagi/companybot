// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { router } from 'expo-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnsavedWorkProvider } from '@/lib/UnsavedWork';
import { NewPage } from './PagesScreen';

type SheetProps = { children: ReactNode; open: boolean; busy: boolean; onDismiss: () => void; onClose: () => void; submit: { label: string; disabled: boolean; onPress: () => void } };
const fixture = vi.hoisted(() => ({ create: vi.fn<(_args: unknown) => Promise<string>>(), sheet: undefined as SheetProps | undefined }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() }, usePreventRemove: () => () => {} }));
vi.mock('@/features/arrangements/ReorderSheet', () => ({ ReorderSheet: () => null }));
vi.mock('@/features/arrangements/useArrangements', () => ({ useArrangements: () => ({}) }));
vi.mock('@/features/session/DirectoryHeader', () => ({ DirectoryHeader: () => null }));
vi.mock('@/design/icons', () => ({ PageIcon: () => null, FolderIcon: () => null }));
vi.mock('@/design', () => ({ useTheme: () => ({}) }));
vi.mock('@/lib/convex', () => ({ useMutation: () => fixture.create, useQuery: () => undefined, usePaginatedQuery: () => undefined }));
vi.mock('@/components/ui/useConfirm', () => ({ useConfirm: () => ({ confirm: async () => true, dialog: null }) }));
vi.mock('@/components/ui', () => ({
  EditorSheet: (props: SheetProps) => {
    fixture.sheet = props;
    return createElement('section', { 'aria-label': props.open ? 'Open editor' : 'Dismissing editor' },
      createElement('button', { disabled: props.submit.disabled, onClick: props.submit.onPress }, props.submit.label), props.children);
  },
  Field: ({ label, value, editable, onChangeText }: { label: string; value: string; editable: boolean; onChangeText: (value: string) => void }) => createElement('input', { 'aria-label': label, value, disabled: !editable, onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
  ErrorState: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const close = vi.fn();
const title = () => host.querySelector<HTMLInputElement>('input')!;
const fill = async (value: string) => act(async () => { title().value = value; title().dispatchEvent(new Event('input', { bubbles: true })); });
beforeEach(async () => {
  fixture.create.mockReset(); fixture.sheet = undefined; close.mockClear(); vi.mocked(router.push).mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(UnsavedWorkProvider, null, createElement(NewPage, { onClose: close }))));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('waits for successful creation and native sheet dismissal before navigating', async () => {
  let resolve!: (id: string) => void;
  fixture.create.mockImplementation(() => new Promise(done => { resolve = done; }));
  await fill('  Team notes  ');
  await act(async () => fixture.sheet!.submit.onPress());
  expect(fixture.create).toHaveBeenCalledExactlyOnceWith({ title: 'Team notes', parentId: undefined });
  expect(fixture.sheet!.busy).toBe(true);
  expect(fixture.sheet!.open).toBe(true);
  expect(close).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
  await act(async () => resolve('created-page'));
  expect(fixture.sheet!.open).toBe(false);
  expect(close).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
  await act(async () => fixture.sheet!.onDismiss());
  expect(close).toHaveBeenCalledOnce();
  expect(router.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/pages/[pageId]', params: { pageId: 'created-page' } });
  expect(close.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(router.push).mock.invocationCallOrder[0]);
});

it('locks repeated creation both before a render and after success while the sheet dismisses', async () => {
  fixture.create.mockResolvedValue('created-page');
  await fill('One page');
  const submit = fixture.sheet!.submit.onPress;
  await act(async () => { submit(); submit(); });
  expect(fixture.create).toHaveBeenCalledOnce();
  expect(fixture.sheet!.submit.disabled).toBe(true);
  expect(title().disabled).toBe(true);
  await act(async () => fixture.sheet!.submit.onPress());
  expect(fixture.create).toHaveBeenCalledOnce();
  expect(router.push).not.toHaveBeenCalled();
});

it('retains the entered title after a failed creation and allows a retry', async () => {
  fixture.create.mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce('retried-page');
  await fill('Draft stays here');
  await act(async () => fixture.sheet!.submit.onPress());
  expect(title().value).toBe('Draft stays here');
  expect(title().disabled).toBe(false);
  expect(fixture.sheet!.open).toBe(true);
  expect(fixture.sheet!.submit.disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Connection interrupted');
  expect(close).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
  await act(async () => fixture.sheet!.submit.onPress());
  expect(fixture.create).toHaveBeenCalledTimes(2);
  expect(fixture.sheet!.open).toBe(false);
  expect(router.push).not.toHaveBeenCalled();
});
