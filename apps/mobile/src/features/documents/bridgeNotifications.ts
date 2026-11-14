/** UI notifications must not leave rejected promises behind when their WebView is removed. */
export function createBridgeNotifications(report: (error: unknown) => void) {
  let active = false;
  let generation = 0;
  return {
    retain() {
      active = true;
      const current = ++generation;
      return () => { if (current === generation) { active = false; generation++; } };
    },
    async send(notify: () => Promise<unknown>) {
      if (!active) return;
      const current = generation;
      try { await notify(); }
      catch (error) { if (active && current === generation) report(error); }
    },
  };
}
