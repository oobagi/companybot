// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDocumentRecovery } from './useDocumentRecovery';
import type { StoredRecovery } from './documentRecoveryStore';

const fixture = vi.hoisted(() => ({ sequence: 0, load: vi.fn(), save: vi.fn(), remove: vi.fn(), open: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `owner-${++fixture.sequence}` }));
vi.mock('./documentRecoveryStore', () => ({ openDocumentRecovery: (scope: string) => {
  fixture.open(scope); return { load: fixture.load, save: fixture.save, remove: fixture.remove };
} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const copies = new Map<string, StoredRecovery>();
let current: ReturnType<typeof useDocumentRecovery>;
const snapshot = { content: '{"type":"doc"}', text: 'Unsaved text', html: '<p>Unsaved text</p>' };
function Editor({ scope }: { scope: string }) { const value = useDocumentRecovery(scope); useEffect(() => { current = value; }, [value]); return createElement('div', null, value.ready ? 'ready' : 'loading'); }
const render = (scope = 'account-a/page-a') => act(async () => root.render(createElement(Editor, { key: scope, scope })));
beforeEach(() => {
  copies.clear(); fixture.open.mockClear(); fixture.remove.mockReset(); fixture.save.mockReset(); fixture.load.mockReset();
  fixture.load.mockImplementation(async () => [...copies.values()]);
  fixture.save.mockImplementation(async (id, value) => { if (value) copies.set(id, { id, updatedAt: 1, snapshot: value }); else copies.delete(id); });
  fixture.remove.mockImplementation(async id => { copies.delete(id); });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('waits for recovery loading and never clears an earlier session when the new editor synchronizes', async () => {
  const old = { id: 'previous-session', updatedAt: 1, snapshot };
  let resolve!: (value: StoredRecovery[]) => void;
  fixture.load.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render();
  expect(current.ready).toBe(false);
  await act(async () => resolve([old]));
  expect(current.restored).toEqual([old]);
  copies.set(old.id, old);
  await act(async () => current.publish(null));
  expect(copies.has(old.id)).toBe(true);
  expect(fixture.save).toHaveBeenCalledExactlyOnceWith(current.owner, null);
  await act(async () => current.discard([old.id]));
  expect(current.restored).toEqual([]);
  expect(copies.has(old.id)).toBe(false);
});

it('keeps published drafts across unmount and exposes them when the same account/page reopens', async () => {
  await render();
  const previousOwner = current.owner;
  await act(async () => current.publish(snapshot));
  await act(async () => root.render(null));
  expect(copies.get(previousOwner)?.snapshot).toEqual(snapshot);
  await render();
  expect(current.owner).not.toBe(previousOwner);
  expect(current.restored).toEqual([{ id: previousOwner, updatedAt: 1, snapshot }]);
});

it('does not label another currently mounted editor as an abandoned recovery draft', async () => {
  const seen = new Map<string, ReturnType<typeof useDocumentRecovery>>();
  function Instance({ name }: { name: string }) { const value = useDocumentRecovery('account-a/page-a'); useEffect(() => { seen.set(name, value); }, [name, value]); return null; }
  await act(async () => root.render(createElement(Instance, { name: 'first', key: 'first' })));
  await act(async () => seen.get('first')!.publish(snapshot));
  await act(async () => root.render([createElement(Instance, { name: 'first', key: 'first' }), createElement(Instance, { name: 'second', key: 'second' })]));
  expect(seen.get('second')!.restored).toEqual([]);
  await act(async () => seen.get('second')!.publish(null));
  expect(copies.has(seen.get('first')!.owner)).toBe(true);
});

it('retains the in-memory draft on write failure and keeps failed discards reviewable', async () => {
  const old = { id: 'old', updatedAt: 1, snapshot }; copies.set(old.id, old);
  await render();
  fixture.save.mockRejectedValueOnce(new Error('disk full'));
  await act(async () => current.publish(snapshot));
  expect(current.latest.current).toEqual(snapshot);
  expect(current.error).toContain('Keep the app open');
  fixture.remove.mockRejectedValueOnce(new Error('disk full'));
  let removed = true;
  await act(async () => { removed = await current.discard([old.id]); });
  expect(removed).toBe(false);
  expect(current.restored).toEqual([old]);
});

it('does not mount an editor after a failed load and allows a retry', async () => {
  fixture.load.mockRejectedValueOnce(new Error('unreadable'));
  await render();
  expect(current.ready).toBe(false);
  expect(current.error).toContain('could not be opened');
  await act(async () => current.reload());
  expect(current.ready).toBe(true);
  expect(current.error).toBeUndefined();
});

it('reports local durability only after the latest draft write finishes', async () => {
  await render();
  const finish: (() => void)[] = [];
  fixture.save.mockImplementation(() => new Promise<void>(resolve => finish.push(resolve)));
  let first!: Promise<void>; let second!: Promise<void>;
  await act(async () => { first = current.publish(snapshot); second = current.publish({ ...snapshot, text: 'Newer edit' }); });
  expect(current.persisted).toBe(false);
  await act(async () => { finish[0](); await first; });
  expect(current.persisted).toBe(false);
  await act(async () => { finish[1](); await second; });
  expect(current.persisted).toBe(true);
});
