export type SelectionSnapshot = {
  hydrated: boolean;
  selected: string | null;
  pending: string | null;
  error: string | null;
};

/** Device selection is independent of the account's mutable last-used hint. */
export class WorkspaceSelection {
  private snapshot: SelectionSnapshot = { hydrated: false, selected: null, pending: null, error: null };
  private ids: string[];
  private listeners = new Set<() => void>();
  constructor(ids: readonly string[], private readonly firstLaunchHint: string | null) { this.ids = [...ids]; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: SelectionSnapshot) {
    if (Object.keys(next).every(key => next[key as keyof SelectionSnapshot] === this.snapshot[key as keyof SelectionSnapshot])) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  hydrate(saved: string | null) {
    if (this.snapshot.hydrated) return;
    const selected = [saved, this.firstLaunchHint].find(id => id && this.ids.includes(id)) ?? this.ids[0] ?? null;
    this.publish({ ...this.snapshot, hydrated: true, selected });
    this.reconcile(this.ids);
  }
  reconcile(ids: readonly string[]) {
    this.ids = [...ids];
    const current = this.snapshot;
    if (!current.hydrated) return;
    if (current.pending && this.ids.includes(current.pending)) {
      this.publish({ hydrated: true, selected: current.pending, pending: null, error: null });
      return;
    }
    if (current.selected && this.ids.includes(current.selected)) return;
    this.publish({ ...current, selected: this.ids[0] ?? null });
  }
  /** A successful create/join can resolve before the subscribed list arrives. */
  choose(id: string) {
    if (this.snapshot.hydrated && this.ids.includes(id)) {
      this.publish({ hydrated: true, selected: id, pending: null, error: null });
      return;
    }
    this.publish({ ...this.snapshot, pending: id, error: null });
  }
  open(id: string): boolean {
    if (!this.ids.includes(id)) return false;
    this.choose(id);
    return true;
  }
  rejectPending(id: string) {
    if (this.snapshot.pending !== id) return;
    this.publish({ ...this.snapshot, pending: null, error: 'That workspace is not available. Try joining or opening it again.' });
  }
  clearError = () => this.publish({ ...this.snapshot, error: null });
}

export function workspaceStorageKey(deployment: string, userId: string) {
  return `companybot.workspace.${encodeURIComponent(deployment)}.${encodeURIComponent(userId)}`;
}

/** Updating the detected zone must never replace the user's explicit choice. */
export function deviceZoneUpdate(detected: string, previous: string | null | undefined) {
  return detected && detected !== previous ? { deviceTimeZone: detected } : null;
}
