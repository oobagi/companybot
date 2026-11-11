import { expect, it, vi } from 'vitest';
import { createDocumentRecoveryStore, recoveryScope, type RecoveryFiles } from './documentRecoveryStore';
import type { RecoverySnapshot } from './editorRecovery';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'revision', CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: vi.fn() }));
vi.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: {} }));
const snapshot = (text: string): RecoverySnapshot => ({ content: JSON.stringify({ type: 'doc', text }), text, html: `<p>${text}</p>` });
function fixture() {
  const disk = new Map<string, string>();
  const files: RecoveryFiles = {
    list: vi.fn(async () => [...disk.keys()]),
    read: vi.fn(async name => { if (!disk.has(name)) throw new Error('Missing file'); return disk.get(name)!; }),
    write: vi.fn(async (name, value) => { disk.set(name, value); }),
    move: vi.fn(async (from, to) => { if (disk.has(to)) throw new Error('Must not overwrite'); disk.set(to, disk.get(from)!); disk.delete(from); }),
    remove: vi.fn(async name => { disk.delete(name); }),
  };
  const open = () => createDocumentRecoveryStore(files, () => 100);
  return { disk, files, open };
}

it('recovers the rich copy after a new process and scopes every identity independently', async () => {
  const { open } = fixture();
  await open().save('editor-a', snapshot('Unsynced'));
  expect(await open().load()).toEqual([{ id: 'editor-a', updatedAt: 100, snapshot: snapshot('Unsynced') }]);
  const original = ['backend', 'user', 'workspace', 'page'];
  const scopes = original.map((_, i) => recoveryScope(...original.map((value, j) => i === j ? `${value}-other` : value) as [string, string, string, string]));
  scopes.push(recoveryScope(...original as [string, string, string, string]));
  expect(new Set(scopes).size).toBe(5);
  expect(recoveryScope('a', 'b.c', 'd', 'e')).not.toBe(recoveryScope('a.b', 'c', 'd', 'e'));
});

it('keeps independent editors of the same page and clears only the acknowledged owner', async () => {
  const { open } = fixture(); const store = open();
  await store.save('editor-a', snapshot('A'));
  await store.save('editor-b', snapshot('B'));
  await store.save('editor-a', null);
  expect((await store.load()).map(value => value.snapshot.text)).toEqual(['B']);
  await store.remove('editor-b');
  expect(await open().load()).toEqual([]);
});

it('coalesces queued edits but a later clear waits for the in-flight durable write', async () => {
  const { files, open } = fixture(); const store = open();
  let finish!: () => void;
  const write = files.write;
  files.write = vi.fn(async (name, value) => { await new Promise<void>(resolve => { finish = resolve; }); await write(name, value); });
  const first = store.save('editor-a', snapshot('First'));
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const second = store.save('editor-a', snapshot('Second'));
  const third = store.save('editor-a', snapshot('Third'));
  const clear = store.save('editor-a', null);
  finish();
  await Promise.all([first, second, third, clear]);
  expect(files.write).toHaveBeenCalledOnce();
  expect(await open().load()).toEqual([]);
});

it('never destroys the previous completed copy when a write or finalization fails', async () => {
  const { files, disk, open } = fixture(); const store = open();
  await store.save('editor-a', snapshot('First'));
  const move = files.move;
  files.move = vi.fn(async () => { throw new Error('Disk full'); });
  await expect(store.save('editor-a', snapshot('Later'))).rejects.toThrow('Disk full');
  expect([...disk.keys()].some(name => name.endsWith('.tmp'))).toBe(true);
  expect((await open().load())[0].snapshot.text).toBe('First');
  files.move = move;
  await store.save('editor-a', snapshot('Newest'));
  expect((await open().load())[0].snapshot.text).toBe('Newest');
  expect([...disk.keys()].filter(name => name.endsWith('.json'))).toHaveLength(1);
});

it('selects the newest finalized revision after interruption before pruning', async () => {
  const { files, open } = fixture(); const store = open();
  await store.save('editor-a', snapshot('First'));
  files.remove = vi.fn(async () => { throw new Error('Interrupted prune'); });
  await expect(store.save('editor-a', snapshot('Newest'))).rejects.toThrow('Interrupted prune');
  const recovered = await open().load();
  expect(recovered).toHaveLength(1);
  expect(recovered[0].snapshot.text).toBe('Newest');
});

it('rejects unreadable completed copies without deleting them and can retry after I/O failure', async () => {
  const { files, disk, open } = fixture(); const store = open();
  disk.set('editor-a.1.bad.json', '{broken');
  await expect(store.load()).rejects.toThrow();
  expect(disk.has('editor-a.1.bad.json')).toBe(true);
  expect(files.remove).not.toHaveBeenCalled();
  await store.remove('editor-a'); // Only an explicit owner removal retires unreadable copies.
  await store.save('editor-b', snapshot('Available'));
  expect((await store.load())[0].snapshot.text).toBe('Available');
});

it('orders a read between writes and rejects path-like owner IDs', async () => {
  const { open, disk } = fixture(); const store = open();
  const first = store.save('editor-a', snapshot('First'));
  const before = store.load();
  const later = store.save('editor-a', snapshot('Later'));
  await Promise.all([first, later]);
  expect((await before)[0].snapshot.text).toBe('First');
  expect((await store.load())[0].snapshot.text).toBe('Later');
  await expect(store.remove('../other')).rejects.toThrow('Invalid recovery owner');
  expect(disk.size).toBe(1);
});
