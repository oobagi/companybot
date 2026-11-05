/** Reserve one transition decision, and retire its continuation when its screen leaves. */
export function createWorkspaceTransition() {
  let generation = 0;
  let active = false;
  let reserved = false;
  return {
    retain() {
      active = true;
      const current = ++generation;
      return () => { if (generation === current) { active = false; reserved = false; generation++; } };
    },
    async run(approve: () => Promise<boolean>, execute: (isCurrent: () => boolean) => Promise<unknown>) {
      if (!active || reserved) return;
      reserved = true;
      const current = generation;
      const isCurrent = () => active && generation === current;
      try {
        if (await approve() && isCurrent()) await execute(isCurrent);
      } finally {
        if (isCurrent()) reserved = false;
      }
    },
  };
}
