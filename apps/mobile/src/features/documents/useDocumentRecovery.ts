import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { openDocumentRecovery, type StoredRecovery } from './documentRecoveryStore';
import type { RecoverySnapshot } from './editorRecovery';

const activeOwners = new Set<string>();

/** Local copies are separate from collaboration and are never submitted as document replacements. */
export function useDocumentRecovery(scope: string) {
  const [owner] = useState(randomUUID);
  const [store] = useState(() => openDocumentRecovery(scope));
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState<StoredRecovery[]>([]);
  const [error, setError] = useState<string>();
  const [persisted, setPersisted] = useState(false);
  const mounted = useRef(false);
  const latest = useRef<RecoverySnapshot | null>(null);
  const revision = useRef(0);
  const load = useCallback(() => store.load().then(copies => {
    if (mounted.current) { setRestored(copies.filter(copy => !activeOwners.has(copy.id))); setReady(true); setError(undefined); }
  }, () => {
    if (mounted.current) setError('Your recovery drafts could not be opened. Try again before editing this document.');
  }), [store]);
  useEffect(() => {
    mounted.current = true; activeOwners.add(owner);
    void load();
    return () => { mounted.current = false; activeOwners.delete(owner); };
  }, [load, owner]);
  const publish = useCallback(async (snapshot: RecoverySnapshot | null) => {
    const current = ++revision.current;
    latest.current = snapshot;
    if (mounted.current) setPersisted(false);
    try {
      await store.save(owner, snapshot);
      if (mounted.current && revision.current === current) { setPersisted(!!snapshot); setError(undefined); }
    } catch {
      if (mounted.current && revision.current === current) setError('A recovery copy could not be saved on this device. Keep the app open until your changes finish syncing.');
    }
  }, [owner, store]);
  const discard = useCallback(async (ids: string[]) => {
    try {
      for (const id of ids) await store.remove(id);
      if (ids.includes(owner)) latest.current = null;
      if (mounted.current) { setRestored(copies => copies.filter(copy => !ids.includes(copy.id))); setError(undefined); }
      return true;
    } catch {
      if (mounted.current) setError('The recovery copy could not be discarded. Try again.');
      return false;
    }
  }, [owner, store]);
  return { owner, ready, restored, error, persisted, latest, publish, discard, reload: load };
}
