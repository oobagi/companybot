/** Busy operations cannot be discarded: their writes may already be on the server. */
export function createUnsavedWorkState() {
  const pending = new Map<string, boolean>();
  return {
    mark(key: string, dirty: boolean, busy = false) {
      if (dirty || busy) pending.set(key, busy);
      else pending.delete(key);
    },
    async confirmDiscard(ask: () => Promise<boolean>, wait: () => Promise<unknown>) {
      if ([...pending.values()].some(Boolean)) { await wait(); return false; }
      if (!pending.size) return true;
      const accepted = await ask();
      // A save/upload may start while the discard alert is open.
      return accepted && ![...pending.values()].some(Boolean);
    },
  };
}
