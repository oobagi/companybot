// @vitest-environment happy-dom
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DocumentSurface } from './DocumentSurface';
import type DocumentDOM from './Editor.dom';

// Keep the native WebView boundary controllable while exercising the real surface
// lifecycle, callbacks and recovery UI. The actual DOM editor has separate tests.
const boundary = vi.hoisted(() => ({ props: undefined as ComponentProps<typeof DocumentDOM> | undefined, mounts: 0, unmounts: 0 }));
vi.mock('react-native', () => ({ View: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('@/design', () => ({ useTheme: () => ({ colors: { background: 'white' } }) }));
vi.mock('@/components/ui', () => ({
  Loading: () => createElement('p', null, 'Opening'),
  ErrorState: ({ message, onRetry }: { message: string; onRetry?: () => void }) => createElement('section', null, message, onRetry && createElement('button', { onClick: onRetry }, 'Retry')),
}));
vi.mock('./Editor.dom', async () => {
  const { useEffect } = await import('react');
  return { default: function MockDocumentDOM(props: ComponentProps<typeof DocumentDOM>) {
    boundary.props = props;
    useEffect(() => { boundary.mounts++; return () => { boundary.unmounts++; }; }, []);
    return createElement('div', null, 'WebView');
  } };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __DEV__: true });
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove(); root = undefined; boundary.props = undefined; boundary.mounts = 0; boundary.unmounts = 0;
});

it.each(['onContentProcessDidTerminate', 'onRenderProcessGone'] as const)('disposes the failed editor on %s and requires confirmation before replacing protected work', async (event) => {
  const status = vi.fn(async () => {});
  const ready = vi.fn();
  const recover = vi.fn(async () => false);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const props: ComponentProps<typeof DocumentDOM> = {
    payload: '', onStatus: status,
    getSteps: async () => ({ steps: [], clientIds: [], version: 1 }), submitSteps: async () => { throw new Error('Unexpected write'); },
    onBlockActions: async () => null, onCreatePage: async () => null, onReferences: async () => {}, onOpenLink: async () => {}, onRemovePages: async () => false, onImageResult: async () => {},
  };
  await act(async () => root!.render(createElement(DocumentSurface, { ...props, protectedWork: true, onReadyChange: ready, onReloadSaved: recover })));
  await act(async () => { await boundary.props!.onStatus(false, null); });
  expect(ready).toHaveBeenLastCalledWith(true);
  const deadView = boundary.props!;
  await act(async () => { Reflect.apply(deadView.dom![event]!, null, []); });
  expect(boundary.unmounts).toBe(1);
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(host.textContent).toContain('closed unexpectedly');
  const reports = status.mock.calls.length;
  await act(async () => { await deadView.onStatus(false, null); });
  expect(status).toHaveBeenCalledTimes(reports);
  await act(async () => host.querySelector('button')!.click());
  expect(recover).toHaveBeenCalledOnce();
  expect(boundary.mounts).toBe(1);
  recover.mockResolvedValue(true);
  await act(async () => host.querySelector('button')!.click());
  expect(boundary.mounts).toBe(2);
  await act(async () => { await deadView.onStatus(false, null); });
  expect(ready).toHaveBeenLastCalledWith(false);
  await act(async () => { await boundary.props!.onStatus(false, null); });
  expect(ready).toHaveBeenLastCalledWith(true);
});
