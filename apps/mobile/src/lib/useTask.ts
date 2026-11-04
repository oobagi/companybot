import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';

/** Locks immediately (before a render), preserves failed forms, ignores unmounted results. */
export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = useCallback(async (task: () => Promise<unknown>): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true); setError(undefined);
    try { await task(); return true; }
    catch (e) { if (mounted.current) setError(errorMessage(e)); return false; }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }, []);
  return { run, busy, error, clear: useCallback(() => setError(undefined), []) };
}
