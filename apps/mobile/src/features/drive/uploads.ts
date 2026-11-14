import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { useMutation, useWorkspace } from '@/lib/convex';
import { useFileUpload, type PickedFile } from '@/lib/fileUpload';

// Uploads into Drive, like desktop: the shared upload endpoint (files.upload), then driveFiles.add
// claims each one into its folder or the top level. One app-wide list, so a folder's screen shows
// its uploads even after you leave and come back.

export type DriveUpload = { key: string; workspaceId: string; name: string; parentId: Id<'pages'> | null; state: 'waiting' | 'sending'; error?: string };

/** Runs jobs `atOnce` at a time, the rest in order; a failed one holds up nothing. */
export function limiter(atOnce: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  const next = () => { if (running < atOnce) waiting.shift()?.(); };
  return <T,>(job: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    waiting.push(() => { running++; job().then(resolve, reject).finally(() => { running--; next(); }); });
    next();
  });
}
const inTurn = limiter(3);

let pending: DriveUpload[] = [];
let counter = 0;
const listeners = new Set<() => void>();
const set = (next: DriveUpload[]) => { pending = next; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => pending;
const update = (key: string, patch: Partial<DriveUpload>) => set(pending.map(u => u.key === key ? { ...u, ...patch } : u));
const drop = (key: string) => set(pending.filter(u => u.key !== key));

export function useDriveUploads(parentId?: Id<'pages'>) {
  const upload = useFileUpload();
  const add = useMutation(api.driveFiles.add);
  const discard = useMutation(api.files.discard);
  const workspace = useWorkspace();
  const list = useSyncExternalStore(subscribe, read);
  const start = (files: PickedFile[]) => {
    if (!workspace) return;
    for (const picked of files) {
      const key = `upload-${++counter}`;
      set([...pending, { key, workspaceId: workspace.id, name: picked.name, parentId: parentId ?? null, state: 'waiting' }]);
      void inTurn(async () => {
        update(key, { state: 'sending' });
        const file = await upload(picked);
        try { await add({ file, parentId }); } catch (e) { await discard({ file }).catch(() => {}); throw e; }
      }).then(() => drop(key), (e: unknown) => update(key, { error: e instanceof Error ? e.message : String(e) }));
    }
  };
  const here = list.filter(u => u.workspaceId === workspace?.id && u.parentId === (parentId ?? null));
  return { uploads: here, start, dismiss: drop };
}
