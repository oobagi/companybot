import { errorMessage } from '@/lib/api';
import type { Draft } from './draftStorage';

type Store = { read: (key: string) => Draft; write: (key: string, draft: Draft) => void };

/** The draft owns the lock across composer unmounts. Keep its persisted contents until acknowledged. */
export async function deliverDraft(store: Store, key: string, send: (draft: Draft) => Promise<unknown>): Promise<boolean> {
  const current = store.read(key);
  if (!current.ready || current.sending || (!current.text.trim() && !current.files.length) || current.files.some(file => !file.file)) return false;
  const pending: Draft = { ...current, sending: true, sendError: undefined };
  store.write(key, pending);
  try {
    await send(current);
    if (store.read(key) === pending) store.write(key, { ...pending, text: '', mentions: [], files: [], sending: undefined });
    return true;
  } catch (error) {
    if (store.read(key) === pending) store.write(key, { ...current, sendError: errorMessage(error) });
    return false;
  }
}
