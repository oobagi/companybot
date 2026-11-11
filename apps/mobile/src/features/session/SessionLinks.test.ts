// @vitest-environment happy-dom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionLinks, SessionLinkNavigation } from './SessionLinks';

const state = vi.hoisted(() => ({
  authenticated: false, loading: true, initial: null as string | null, rootKey: undefined as string | undefined,
  listener: undefined as ((event: { url: string }) => void) | undefined,
  replace: vi.fn(), removed: vi.fn(), initialReads: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('convex/react', () => ({ useConvexAuth: () => ({ isAuthenticated: state.authenticated, isLoading: state.loading }) }));
vi.mock('expo-router', () => ({ router: { replace: state.replace }, useRootNavigationState: () => state.rootKey ? { key: state.rootKey } : undefined }));
vi.mock('expo-linking', () => ({
  getLinkingURL: () => { state.initialReads(); return state.initial; },
  addEventListener: (_type: string, listener: (event: { url: string }) => void) => {
    state.listener = listener;
    return { remove: () => { state.removed(); state.listener = undefined; } };
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const render = (workspaceReady = false) => act(async () => root.render(createElement(StrictMode, null,
  createElement(SessionLinks, null, state.authenticated && workspaceReady ? createElement(SessionLinkNavigation) : null),
)));
beforeEach(() => {
  state.authenticated = false; state.loading = true; state.initial = null; state.rootKey = undefined;
  state.replace.mockClear(); state.removed.mockClear(); state.initialReads.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('retains a cold-start destination through login and workspace loading, then consumes it once', async () => {
  state.initial = 'companybot://databases';
  await render();
  state.loading = false; await render();
  expect(state.replace).not.toHaveBeenCalled();
  state.authenticated = true; await render();
  expect(state.replace).not.toHaveBeenCalled();
  await render(true);
  expect(state.replace).not.toHaveBeenCalled(); // Root navigator is not ready yet.
  state.rootKey = 'root'; await render(true);
  expect(state.replace).toHaveBeenCalledExactlyOnceWith('/databases');
  await render(false); await render(true); // Workspace remount and StrictMode cannot replay it.
  expect(state.replace).toHaveBeenCalledOnce();
});

it('uses the latest signed-out event rather than the launch URL and retains message targets', async () => {
  state.initial = 'companybot://pages/oldpage'; await render();
  await act(async () => state.listener!({ url: 'companybot://chat/chat123/thread/thread123?messageId=msg123' }));
  state.initial = 'companybot://pages/oldpage'; // Native cached launch URL remains stale.
  state.authenticated = true; state.rootKey = 'root'; await render(true);
  expect(state.replace).toHaveBeenCalledExactlyOnceWith('/chat/chat123/thread/thread123?messageId=msg123');
});

it('clears an unconsumed previous-account link on sign-out and accepts a newly opened identical URL', async () => {
  state.initial = 'companybot://pages/page123'; await render();
  state.authenticated = true; await render(); // Workspace has not loaded.
  state.authenticated = false; await render();
  state.authenticated = true; state.rootKey = 'root'; await render(true);
  expect(state.replace).not.toHaveBeenCalled();
  state.authenticated = false; await render();
  await act(async () => state.listener!({ url: 'companybot://pages/page123' }));
  state.authenticated = true; await render(true);
  expect(state.replace).toHaveBeenCalledExactlyOnceWith('/pages/page123');
});

it('does not duplicate warm signed-in routing or replay it into a later login', async () => {
  state.authenticated = true; state.rootKey = 'root'; state.initial = 'companybot://settings';
  await render(true);
  await act(async () => state.listener!({ url: 'companybot://pages/page123' }));
  expect(state.replace).not.toHaveBeenCalled();
  state.authenticated = false; await render();
  state.authenticated = true; await render(true);
  expect(state.replace).not.toHaveBeenCalled();
});

it('ignores unsupported URLs while signed out and removes the event listener on unmount', async () => {
  await render();
  await act(async () => state.listener!({ url: 'https://evil.test/pages/page123' }));
  state.authenticated = true; state.rootKey = 'root'; await render(true);
  expect(state.replace).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  expect(state.listener).toBeUndefined();
});
