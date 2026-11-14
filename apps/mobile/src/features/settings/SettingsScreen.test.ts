// @vitest-environment happy-dom
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnsavedWorkProvider, useUnsavedWork } from '@/lib/UnsavedWork';
import SettingsScreen from './SettingsScreen';

const fixture = vi.hoisted(() => ({ cleanup: vi.fn(), signOut: vi.fn(), confirm: vi.fn(), requestClose: undefined as (() => void) | undefined }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('react-native', () => ({ Modal: ({ visible, children, onRequestClose }: { visible: boolean; children: ReactNode; onRequestClose: () => void }) => {
  fixture.requestClose = onRequestClose;
  return visible ? createElement('section', { role: 'dialog' }, children) : null;
} }));
vi.mock('@/features/session/DirectoryHeader', () => ({ DirectoryHeader: () => null }));
vi.mock('@convex-dev/auth/react', () => ({ useAuthActions: () => ({ signOut: fixture.signOut }) }));
vi.mock('@/lib/notifications/NotificationsProvider', () => ({ useNotifications: () => ({ beforeSignOut: fixture.cleanup }) }));
vi.mock('@/lib/convex', () => ({ useQuery: () => undefined }));
vi.mock('@/components/ui/useConfirm', () => ({ useConfirm: () => ({ confirm: fixture.confirm, dialog: null }) }));
vi.mock('@/components/ui', () => ({
  Screen: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Loading: ({ label }: { label: string }) => createElement('p', null, label),
}));
vi.mock('./SettingsContent', () => ({ SettingsContent: ({ onSignOut, signingOut, error }: { onSignOut: () => void; signingOut: boolean; error?: string }) => createElement('div', null,
  createElement('button', { onClick: onSignOut, disabled: signingOut }, 'Sign out'), error && createElement('p', { role: 'alert' }, error)) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement; let root: Root; let work: ReturnType<typeof useUnsavedWork>;
function Probe() { const value = useUnsavedWork(); useEffect(() => { work = value; }, [value]); return createElement(SettingsScreen); }
const click = () => host.querySelector<HTMLButtonElement>('button')!.click();
beforeEach(async () => {
  fixture.cleanup.mockReset().mockResolvedValue(undefined); fixture.signOut.mockReset().mockResolvedValue(undefined); fixture.confirm.mockReset().mockResolvedValue(true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(UnsavedWorkProvider, null, createElement(Probe))));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('holds a modal and global operation lock throughout cleanup and sign-out', async () => {
  let finishCleanup!: () => void; let finishSignOut!: () => void;
  fixture.cleanup.mockImplementation(() => new Promise<void>(resolve => { finishCleanup = resolve; }));
  fixture.signOut.mockImplementation(() => new Promise<void>(resolve => { finishSignOut = resolve; }));
  await act(async () => { click(); click(); });
  expect(fixture.cleanup).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="dialog"]')?.textContent).toBe('Signing out…');
  expect(fixture.signOut).not.toHaveBeenCalled();
  await act(async () => fixture.requestClose!());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  let canSwitch = true;
  await act(async () => { canSwitch = await work.confirmDiscard(); });
  expect(canSwitch).toBe(false);
  await act(async () => finishCleanup());
  expect(fixture.signOut).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => finishSignOut());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(await work.confirmDiscard()).toBe(true);
});

it('keeps existing drafts when discard is declined, without starting cleanup', async () => {
  work.mark('form', true); fixture.confirm.mockResolvedValue(false);
  await act(async () => click());
  expect(fixture.cleanup).not.toHaveBeenCalled();
  expect(fixture.signOut).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it('releases the modal and operation lock after cleanup failure and permits retry', async () => {
  fixture.cleanup.mockRejectedValueOnce(new Error('Cleanup failed'));
  await act(async () => click());
  expect(fixture.signOut).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Cleanup failed');
  expect(await work.confirmDiscard()).toBe(true);
  await act(async () => click());
  expect(fixture.signOut).toHaveBeenCalledOnce();
});

it('does not sign out a replacement session after the initiating screen unmounts', async () => {
  let finish!: () => void;
  fixture.cleanup.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await act(async () => click());
  await act(async () => root.render(null));
  await act(async () => finish());
  expect(fixture.signOut).not.toHaveBeenCalled();
});
