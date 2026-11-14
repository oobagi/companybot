import { describe, expect, it } from 'vitest';
import { MESSAGE_SEEK_BATCH, messageSeekState, orderedMessages } from './pagination';
import { messageTimeline } from './dates';
import { approvalFailure } from './approvalOutcome';

const row = (_id: string, shownAt: number) => ({ _id, shownAt, status: 'done' });

describe('paginated chat history', () => {
  it('joins newest-first pages by publication, keeping an old thread parent first exactly once', () => {
    const parent = row('parent', 100);
    const latest = [parent, row('late-publication', 30), row('latest', 40)];
    const older = [row('oldest-reply', 10), row('older-reply', 20)];
    const sorted = orderedMessages([...latest, ...older, parent], 'parent');
    expect(sorted.map(m => m._id)).toEqual(['parent', 'oldest-reply', 'older-reply', 'late-publication', 'latest']);
    expect(latest[0]).toBe(parent);
    expect(messageTimeline(sorted, new Set()).data.map(m => m._id)).toEqual(['latest', 'late-publication', 'older-reply', 'oldest-reply', 'parent']);
  });

  it('preserves existing inverted rows as older pages arrive', () => {
    const recent = [row('recent', 30), row('newest', 40)];
    const before = messageTimeline(orderedMessages(recent), new Set()).data;
    const after = messageTimeline(orderedMessages([...recent, row('older', 20), row('oldest', 10)]), new Set()).data;
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('bounds automatic seeking, permits continuation past 200 and 500, and distinguishes exhausted history', () => {
    expect(messageSeekState('target', false, 200, 'CanLoadMore', MESSAGE_SEEK_BATCH)).toBe('loading');
    expect(messageSeekState('target', false, 500, 'CanLoadMore', MESSAGE_SEEK_BATCH)).toBe('continue');
    expect(messageSeekState('target', false, 500, 'CanLoadMore', MESSAGE_SEEK_BATCH * 2)).toBe('loading');
    expect(messageSeekState('target', false, 550, 'Exhausted', MESSAGE_SEEK_BATCH * 2)).toBe('missing');
    expect(messageSeekState('target', true, 550, 'Exhausted', MESSAGE_SEEK_BATCH * 2)).toBe('found');
    expect(messageSeekState(undefined, false, 50, 'CanLoadMore', MESSAGE_SEEK_BATCH)).toBe('idle');
  });

  it('uses the day a delayed reply was shown rather than its earlier creation day', () => {
    const yesterday = new Date(2026, 10, 3, 23).getTime();
    const today = new Date(2026, 10, 4, 1).getTime();
    const delayed = { ...row('delayed', today), _creationTime: yesterday };
    const timeline = messageTimeline([row('earlier', yesterday), delayed], new Set(), today);
    expect([...timeline.days]).toEqual([['earlier', 'Yesterday'], ['delayed', 'Today']]);
  });
});

describe('approval certainty', () => {
  it('distinguishes an interrupted outside operation from a known failure', () => {
    expect(approvalFailure({ outcome: 'unknown', error: 'Disconnected.' })).toEqual({ uncertain: true, text: 'Allowed, but it may or may not have happened. Disconnected.' });
    expect(approvalFailure({ outcome: null, error: 'Access refused.' })).toEqual({ uncertain: false, text: 'Failed: Access refused.' });
  });
});
