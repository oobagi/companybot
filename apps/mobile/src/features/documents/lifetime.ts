/** React StrictMode can detach and immediately reattach the same editor. */
export function createEditorLifetime(destroy: () => void) {
  let leases = 0;
  let destroyed = false;
  return {
    retain() {
      leases++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases--;
        queueMicrotask(() => {
          if (leases || destroyed) return;
          destroyed = true;
          destroy();
        });
      };
    },
  };
}
