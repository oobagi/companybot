import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from './api';
import { useOptionalUnsavedWork } from './UnsavedWork';

/** Locks immediately (before a render), preserves failed forms, ignores unmounted results. */
export function useTask({ guardWorkspace = true }: { guardWorkspace?: boolean } = {}) {
  const work = useOptionalUnsavedWork();
  const identity = useId();
  const mark = work?.mark;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; mark?.(identity, false); }; }, [identity, mark]);
  const run = useCallback(async (task: () => Promise<unknown>): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true;
    // Register before the first await/render, so notification navigation sees the lock.
    if (guardWorkspace) mark?.(identity, false, true);
    setBusy(true); setError(undefined);
    try { await task(); return true; }
    catch (e) { if (mounted.current) setError(errorMessage(e)); return false; }
    finally { locked.current = false; mark?.(identity, false); if (mounted.current) setBusy(false); }
  }, [guardWorkspace, identity, mark]);
  return { run, busy, error, clear: useCallback(() => setError(undefined), []) };
}
