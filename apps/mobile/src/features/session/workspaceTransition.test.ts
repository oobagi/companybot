import { describe, expect, it, vi } from 'vitest';
import { createUnsavedWorkState } from '@/lib/unsavedWorkState';
import { createWorkspaceTransition } from './workspaceTransition';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe('workspace transition lifetime', () => {
  it('allows its own discard decision, then blocks a notification switch during the accepted write', async () => {
    const pending = createUnsavedWorkState();
    pending.mark('editor', true);
    const transition = createWorkspaceTransition(); transition.retain();
    const request = deferred<string>();
    const started = deferred<void>();
    const approved = vi.fn(async () => true);
    const wait = vi.fn(async () => {});
    const choices: string[] = [];
    const join = transition.run(() => pending.confirmDiscard(approved, wait), async isCurrent => {
      pending.mark('transition', false, true);
      started.resolve();
      try { const workspace = await request.promise; if (isCurrent()) choices.push(workspace); }
      finally { pending.mark('transition', false); }
    });
    await started.promise;
    expect(approved).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(await pending.confirmDiscard(async () => true, wait)).toBe(false);
    request.resolve('joined'); await join;
    expect(choices).toEqual(['joined']);
    expect(await pending.confirmDiscard(async () => true, wait)).toBe(true);
  });

  it('does not submit twice while the same discard decision is open', async () => {
    const transition = createWorkspaceTransition(); transition.retain();
    const answer = deferred<boolean>();
    const write = vi.fn(async () => {});
    const first = transition.run(() => answer.promise, write);
    await transition.run(async () => true, write);
    expect(write).not.toHaveBeenCalled();
    answer.resolve(true); await first;
    expect(write).toHaveBeenCalledOnce();
  });

  it('ignores a discard approval after navigation retires the requesting screen', async () => {
    const transition = createWorkspaceTransition(); const leave = transition.retain();
    const answer = deferred<boolean>(); const write = vi.fn(async () => {});
    const first = transition.run(() => answer.promise, write);
    leave(); transition.retain();
    answer.resolve(true); await first;
    expect(write).not.toHaveBeenCalled();
    await transition.run(async () => true, write);
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not replace the newer destination when an old create or join finishes after unmount', async () => {
    const transition = createWorkspaceTransition(); const leave = transition.retain();
    const request = deferred<string>(); let selected = 'original';
    const first = transition.run(async () => true, async isCurrent => {
      const workspace = await request.promise;
      if (isCurrent()) selected = workspace;
    });
    await Promise.resolve();
    leave(); transition.retain(); selected = 'notification';
    request.resolve('old-create'); await first;
    expect(selected).toBe('notification');
  });
});
