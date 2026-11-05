/** Pages arrive newest first, each internally chronological. A thread parent stays first. */
export function orderedMessages<T extends { _id: string; shownAt: number }>(rows: readonly T[], threadId?: string): T[] {
  return [...new Map(rows.map(row => [row._id, row])).values()].sort((a, b) =>
    Number(b._id === threadId) - Number(a._id === threadId) || a.shownAt - b.shownAt);
}

export const MESSAGE_SEEK_BATCH = 500;
export type SeekState = 'idle' | 'found' | 'loading' | 'continue' | 'missing';

/** A bound on automatic work, never a limit on how far a person can browse. */
export function messageSeekState(target: string | undefined, found: boolean, count: number, status: string, limit: number): SeekState {
  if (!target) return 'idle';
  if (found) return 'found';
  if (status === 'Exhausted') return 'missing';
  if (status === 'LoadingFirstPage' || status === 'LoadingMore' || count < limit) return 'loading';
  return 'continue';
}
