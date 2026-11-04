import { describe, expect, it } from 'vitest';
import { messageDayLabel, messageTimeline } from './dates';

const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
const row = (id: string, day: number, status = 'done') => ({ _id: id, _creationTime: at(day), status });

describe('message chronology with live subscriptions', () => {
  it('keeps an invisible streaming row mounted and moves the date header when its live approval appears', () => {
    const messages = [row('older', 3), row('stream', 4, 'streaming'), row('reply', 4)];
    const hidden = messageTimeline(messages, new Set(), at(4));
    expect(hidden.data.map(message => message._id)).toEqual(['reply', 'stream', 'older']);
    expect([...hidden.days]).toEqual([['older', 'Yesterday'], ['reply', 'Today']]);
    const live = messageTimeline(messages, new Set(['stream']), at(4));
    expect([...live.days]).toEqual([['older', 'Yesterday'], ['stream', 'Today']]);
  });

  it('counts private placeholders as visible without exposing reply contents', () => {
    const privateReply = { ...row('private', 4, 'streaming'), privacy: { hidden: true } };
    const timeline = messageTimeline([privateReply, row('next', 4)], new Set(), at(4));
    expect([...timeline.days]).toEqual([['private', 'Today']]);
  });

  it('uses calendar days across month and year boundaries', () => {
    expect(messageDayLabel(new Date(2026, 11, 31, 23, 59).getTime(), new Date(2027, 0, 1, 0, 1).getTime())).toBe('Yesterday');
    expect(messageDayLabel(new Date(2025, 10, 4).getTime(), at(4))).not.toBe('Today');
  });
});
