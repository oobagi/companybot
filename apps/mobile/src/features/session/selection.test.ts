import { describe, expect, it } from 'vitest';
import { deviceZoneUpdate, WorkspaceSelection, workspaceStorageKey } from './selection';

describe('device workspace selection', () => {
  it('hydrates the saved membership ahead of the last-used hint', () => {
    const state = new WorkspaceSelection(['a', 'b'], 'b');
    state.hydrate('a');
    expect(state.getSnapshot()).toMatchObject({ hydrated: true, selected: 'a' });
    state.reconcile(['a', 'b', 'c']);
    expect(state.getSnapshot().selected).toBe('a');
  });
  it('uses last-used only on first launch, then pins fallback after revocation', () => {
    const state = new WorkspaceSelection(['a', 'b'], 'b');
    state.hydrate(null);
    expect(state.getSnapshot().selected).toBe('b');
    state.reconcile(['a']);
    expect(state.getSnapshot().selected).toBe('a');
    state.reconcile(['b', 'a']);
    expect(state.getSnapshot().selected).toBe('a');
  });
  it('ignores a saved workspace the account no longer belongs to', () => {
    const state = new WorkspaceSelection(['a'], 'removed');
    state.hydrate('another-account-workspace');
    expect(state.getSnapshot().selected).toBe('a');
    expect(state.open('another-account-workspace')).toBe(false);
    expect(state.getSnapshot().selected).toBe('a');
  });
  it('holds a successful create/join choice until the membership subscription arrives', () => {
    const state = new WorkspaceSelection(['a'], 'a');
    state.hydrate('a');
    state.choose('new');
    state.reconcile(['a']);
    expect(state.getSnapshot()).toMatchObject({ selected: 'a', pending: 'new' });
    state.reconcile(['a', 'new']);
    expect(state.getSnapshot()).toMatchObject({ selected: 'new', pending: null });
  });
  it('preserves a requested choice through a delayed storage read', () => {
    const state = new WorkspaceSelection(['a', 'b'], 'a');
    state.choose('b');
    state.hydrate('a');
    expect(state.getSnapshot()).toMatchObject({ selected: 'b', pending: null });
  });
  it('does not let an expired old request cancel a newer choice', () => {
    const state = new WorkspaceSelection(['a'], 'a');
    state.hydrate(null);
    state.choose('first');
    state.choose('second');
    state.rejectPending('first');
    expect(state.getSnapshot().pending).toBe('second');
    state.rejectPending('second');
    expect(state.getSnapshot()).toMatchObject({ selected: 'a', pending: null });
    expect(state.getSnapshot().error).toBeTruthy();
    state.clearError();
    expect(state.getSnapshot().error).toBeNull();
  });
  it('reconciles a first workspace after onboarding without losing the returned id', () => {
    const state = new WorkspaceSelection([], null);
    state.hydrate(null);
    state.choose('new');
    state.reconcile([]);
    expect(state.getSnapshot().pending).toBe('new');
    state.reconcile(['new']);
    expect(state.getSnapshot()).toMatchObject({ selected: 'new', pending: null });
    state.reconcile([]);
    expect(state.getSnapshot().selected).toBeNull();
  });
  it('separates persistence by account and deployment', () => {
    expect(workspaceStorageKey('https://one.convex.cloud', 'a')).not.toBe(workspaceStorageKey('https://one.convex.cloud', 'b'));
    expect(workspaceStorageKey('https://one.convex.cloud', 'a')).not.toBe(workspaceStorageKey('https://two.convex.cloud', 'a'));
  });
  it('emits only changed snapshots and cleans up subscriptions', () => {
    const state = new WorkspaceSelection(['a'], null);
    let count = 0;
    const unsubscribe = state.subscribe(() => { count++; });
    state.hydrate(null);
    const snapshot = state.getSnapshot();
    state.reconcile(['a']);
    expect(state.getSnapshot()).toBe(snapshot);
    expect(count).toBe(1);
    unsubscribe();
    state.reconcile([]);
    expect(count).toBe(1);
  });
});

describe('detected device time zone', () => {
  it('updates only the device zone, preserving a manual account choice', () => {
    expect(deviceZoneUpdate('Europe/Paris', 'America/Los_Angeles')).toEqual({ deviceTimeZone: 'Europe/Paris' });
    expect(deviceZoneUpdate('Europe/Paris', 'Europe/Paris')).toBeNull();
    expect(deviceZoneUpdate('', null)).toBeNull();
  });
});
