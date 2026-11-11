import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { errorMessage } from '@/lib/api';
import { deserializeDraft, emptyDraft, serializeDraft, type Draft } from './draftStorage';
import { deliverDraft } from './sendDraft';
export type { DraftFile } from './draftStorage';

const empty = emptyDraft;
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
const loading = new Set<string>();
const writes = new Map<string, Promise<void>>();
const publish = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const readDraft = (key: string) => drafts.get(key) ?? empty;
function writeDraft(key: string, after: Draft) {
  const before = readDraft(key);
  drafts.set(key, after);
  if (after.text !== before.text || after.mentions !== before.mentions || after.files !== before.files) {
    const value = serializeDraft(after, Date.now());
    const write = (writes.get(key) ?? Promise.resolve()).then(() => AsyncStorage.setItem(key, value)).catch(() => {});
    writes.set(key, write);
    void write.finally(() => { if (writes.get(key) === write) writes.delete(key); });
  }
  publish();
}
export function changeDraft(key: string, update: (draft: Draft) => Draft) {
  const before = readDraft(key);
  if (!before.ready || before.sending) return;
  writeDraft(key, { ...update(before), sendError: undefined });
}
export const sendChatDraft = (key: string, send: (draft: Draft) => Promise<unknown>) => deliverDraft({ read: readDraft, write: writeDraft }, key, send);

export function useChatDraft(key: string) {
  const draft = useSyncExternalStore(subscribe, () => readDraft(key), () => empty);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (readDraft(key).ready || loading.has(key)) return;
    loading.add(key);
    drafts.set(key, { ...readDraft(key), loadError: undefined });
    publish();
    void AsyncStorage.getItem(key).then((raw) => { drafts.set(key, deserializeDraft(raw, Date.now())); }, error => {
      // An unread draft may still exist on disk. Never enable edits that would overwrite it.
      drafts.set(key, { ...readDraft(key), ready: false, loadError: errorMessage(error) });
    }).finally(() => { loading.delete(key); publish(); });
  }, [key, attempt]);
  return { ...draft, retryLoad: () => setAttempt(value => value + 1) };
}
