import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { deserializeDraft, emptyDraft, serializeDraft, type Draft } from './draftStorage';
export type { DraftFile } from './draftStorage';

const empty = emptyDraft;
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
const loading = new Set<string>();
const writes = new Map<string, Promise<void>>();
const publish = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const readDraft = (key: string) => drafts.get(key) ?? empty;
export function changeDraft(key: string, update: (draft: Draft) => Draft) {
  const before = readDraft(key);
  if (!before.ready) return;
  const after = update(before);
  drafts.set(key, after);
  if (after.text !== before.text || after.mentions !== before.mentions || after.files !== before.files) {
    const value = serializeDraft(after, Date.now());
    const write = (writes.get(key) ?? Promise.resolve()).then(() => AsyncStorage.setItem(key, value)).catch(() => {});
    writes.set(key, write);
    void write.finally(() => { if (writes.get(key) === write) writes.delete(key); });
  }
  publish();
}
export function useChatDraft(key: string) {
  const draft = useSyncExternalStore(subscribe, () => readDraft(key), () => empty);
  useEffect(() => {
    if (readDraft(key).ready || loading.has(key)) return;
    loading.add(key);
    void AsyncStorage.getItem(key).then((raw) => { drafts.set(key, deserializeDraft(raw, Date.now())); }, () => { drafts.set(key, { ...readDraft(key), ready: true }); }).finally(() => { loading.delete(key); publish(); });
  }, [key]);
  return draft;
}
