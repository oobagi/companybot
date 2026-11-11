import { Platform } from 'react-native';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import type { RecoverySnapshot } from './editorRecovery';

export type StoredRecovery = { id: string; updatedAt: number; snapshot: RecoverySnapshot };
export type RecoveryFiles = {
  list(): Promise<string[]>;
  read(name: string): Promise<string>;
  write(name: string, content: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
};

/** Include every access boundary; hashing below is only for filesystem-safe names. */
export const recoveryScope = (deployment: string, userId: string, workspaceId: string, pageId: string) =>
  JSON.stringify([deployment, userId, workspaceId, pageId]);

function decode(content: string): StoredRecovery {
  const value = JSON.parse(content);
  if (value?.version !== 1 || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value.id)
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || typeof value.snapshot?.content !== 'string' || typeof value.snapshot?.text !== 'string' || typeof value.snapshot?.html !== 'string') {
    throw new Error('The saved recovery copy could not be read. It has been kept on this device.');
  }
  return { id: value.id, updatedAt: value.updatedAt, snapshot: value.snapshot };
}

/** One queue per document scope, shared by all mounted instances of that page. */
export function createDocumentRecoveryStore(files: RecoveryFiles, now = Date.now, unique = randomUUID) {
  let queue = Promise.resolve();
  let stamp = 0;
  let pending: { id: string; snapshot: RecoverySnapshot | null; promise: Promise<void> } | undefined;
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.then(() => {}, () => {});
    return result;
  }
  async function read(name: string) {
    const value = decode(await files.read(name));
    if (!name.startsWith(`${value.id}.${value.updatedAt}.`)) throw new Error('The saved recovery copy does not match its file. It has been kept on this device.');
    return value;
  }
  const save = (id: string, snapshot: RecoverySnapshot | null): Promise<void> => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return Promise.reject(new Error('Invalid recovery owner.'));
    // Replace only an adjacent queued save. A read or removal remains an ordering barrier.
    if (pending?.id === id) { pending.snapshot = snapshot; return pending.promise; }
    const operation = { id, snapshot, promise: Promise.resolve() };
    pending = operation;
    operation.promise = enqueue(async () => {
      if (pending === operation) pending = undefined;
      const previous = (await files.list()).filter(name => name.startsWith(`${id}.`));
      if (operation.snapshot === null) {
        for (const name of previous) await files.remove(name);
        return;
      }
      // A finalized file is never overwritten. If writing or moving fails, the
      // previous revision stays recoverable and unfinished .tmp files are ignored.
      stamp = Math.max(stamp + 1, now());
      const revision = `${id}.${stamp}.${unique()}`;
      await files.write(`${revision}.tmp`, JSON.stringify({ version: 1, id, updatedAt: stamp, snapshot: operation.snapshot }));
      await files.move(`${revision}.tmp`, `${revision}.json`);
      for (const name of previous.filter(name => name.endsWith('.json'))) {
        // Do not silently delete an unreadable user recovery file during pruning.
        try { await read(name); } catch { continue; }
        await files.remove(name);
      }
    });
    return operation.promise;
  };
  return {
    load(): Promise<StoredRecovery[]> {
      pending = undefined;
      return enqueue(async () => {
        const owners = new Map<string, StoredRecovery>();
        for (const name of (await files.list()).filter(name => name.endsWith('.json'))) {
          const value = await read(name);
          stamp = Math.max(stamp, value.updatedAt);
          if (!owners.has(value.id) || owners.get(value.id)!.updatedAt < value.updatedAt) owners.set(value.id, value);
        }
        return [...owners.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      });
    },
    save,
    remove(id: string) { pending = undefined; const result = save(id, null); pending = undefined; return result; },
  };
}

function nativeFiles(scope: string): RecoveryFiles {
  let location: Promise<Directory> | undefined;
  const directory = () => location ??= digestStringAsync(CryptoDigestAlgorithm.SHA256, scope).then(hash => {
    const folder = new Directory(Paths.document, 'document-recovery-v1', hash);
    folder.create({ intermediates: true, idempotent: true });
    return folder;
  }).catch(error => { location = undefined; throw error; });
  return {
    list: async () => (await directory()).list().filter(entry => entry instanceof File).map(entry => entry.name),
    read: async name => new File(await directory(), name).text(),
    write: async (name, content) => { await new File(await directory(), name).write(content); },
    move: async (from, to) => { const folder = await directory(); await new File(folder, from).move(new File(folder, to)); },
    remove: async name => { const file = new File(await directory(), name); if (file.exists) file.delete(); },
  };
}

function memoryFiles(): RecoveryFiles {
  const files = new Map<string, string>();
  return {
    list: async () => [...files.keys()], read: async name => files.get(name)!,
    write: async (name, content) => { files.set(name, content); },
    move: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    remove: async name => { files.delete(name); },
  };
}
const stores = new Map<string, ReturnType<typeof createDocumentRecoveryStore>>();
export function openDocumentRecovery(scope: string) {
  let store = stores.get(scope);
  if (!store) {
    store = createDocumentRecoveryStore(Platform.OS === 'web' ? memoryFiles() : nativeFiles(scope));
    stores.set(scope, store);
  }
  return store;
}
