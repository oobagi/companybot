import { describe, expect, it, vi } from 'vitest';
import { createUnsavedWorkState } from './unsavedWorkState';

describe('workspace changes with pending work', () => {
  it('allows deliberate draft discard, but never discards a running write', async () => {
    const work = createUnsavedWorkState();
    const ask = vi.fn(async () => true); const wait = vi.fn(async () => {});
    work.mark('draft', true);
    expect(await work.confirmDiscard(ask, wait)).toBe(true);
    work.mark('upload', false, true);
    expect(await work.confirmDiscard(ask, wait)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    work.mark('upload', false);
    expect(await work.confirmDiscard(ask, wait)).toBe(true);
  });
  it('rechecks a write started while discard confirmation was open', async () => {
    const work = createUnsavedWorkState(); work.mark('draft', true);
    let answer!: (accept: boolean) => void;
    const result = work.confirmDiscard(() => new Promise(resolve => { answer = resolve; }), async () => {});
    work.mark('save', true, true); answer(true);
    expect(await result).toBe(false);
  });
  it('does not clear another mounted editor when one instance leaves', async () => {
    const work = createUnsavedWorkState();
    work.mark('page:first', true, true); work.mark('page:second', true, true);
    work.mark('page:first', false);
    expect(await work.confirmDiscard(async () => true, async () => {})).toBe(false);
    work.mark('page:second', false);
    const ask = vi.fn(async () => false);
    expect(await work.confirmDiscard(ask, async () => {})).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
