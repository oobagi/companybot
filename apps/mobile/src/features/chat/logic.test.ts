import { describe, expect, it } from 'vitest';
import { contentDestination, draftMentions, mentionedIn, rebaseMentions, type MentionSpan } from './logic';

describe('mobile mention targeting', () => {
  const people = [{ id: 'a', name: 'Ann', kind: 'user' as const }, { id: 'b', name: 'Anna', kind: 'agent' as const }, { id: 'c', name: 'Ann Lee', kind: 'user' as const }, { id: 'skill', name: 'Research', kind: 'skill' as const }];
  it('uses full names and does not ping name prefixes or email addresses', () => {
    expect(mentionedIn('@Anna ask @Ann Lee. ann@Ann.example /Researching', people).map((p) => p.id)).toEqual(['b', 'c']);
  });
  it('deduplicates and supports punctuation plus skill references', () => {
    expect(mentionedIn('(@Ann), @Ann /Research!', people).map((p) => p.id)).toEqual(['a', 'skill']);
  });
  it('does not silently fan out ambiguous names', () => {
    expect(mentionedIn('@Ann', [...people, { id: 'duplicate', name: 'Ann', kind: 'user' }])).toEqual([]);
  });
  it('preserves the specifically selected identity when display names collide', () => {
    const selected: MentionSpan = { id: 'duplicate', name: 'Ann', kind: 'user', start: 0, end: 4 };
    expect(draftMentions('@Ann ask @Anna', [...people, selected], [selected]).map(p => p.id)).toEqual(['duplicate', 'b']);
    expect(draftMentions('@Ann', people, [selected])).toEqual([]);
  });
  it('moves a picked span with edits outside it and drops edits through its text', () => {
    const span: MentionSpan = { id: 'a', name: 'Ann', kind: 'user', start: 3, end: 7 };
    expect(rebaseMentions('Hi @Ann!', 'Hello @Ann!', [span])).toEqual([{ ...span, start: 6, end: 10 }]);
    expect(rebaseMentions('Hi @Ann!', 'Hi @Anna!', [span])).toEqual([]);
    expect(rebaseMentions('Hi @Ann!', 'Hi !', [span])).toEqual([]);
    expect(rebaseMentions('Hi @Ann!', 'Hi @Ann! Yes', [span])).toEqual([span]);
  });
});

describe('persistent links on mobile', () => {
  it('preserves message and thread destinations', () => {
    expect(contentDestination('#/chat/chat1/message/msg1')).toEqual({ kind: 'path', path: '/chat/chat1', params: { messageId: 'msg1' } });
    expect(contentDestination('#/chat/chat1/thread/msg1')).toEqual({ kind: 'path', path: '/chat/chat1/thread/msg1' });
  });
  it('maps records, databases and retained settings aliases', () => {
    expect(contentDestination('#/records/client/record1')).toEqual({ kind: 'path', path: '/record/record1' });
    expect(contentDestination('#/records/client')).toEqual({ kind: 'database', key: 'client' });
    expect(contentDestination('#/customize/agents/agent1')).toEqual({ kind: 'path', path: '/settings/agents', params: { itemId: 'agent1' } });
    expect(contentDestination('#/settings/trash')).toEqual({ kind: 'path', path: '/settings/archive' });
    expect(contentDestination('companybot://page/page1')).toEqual({ kind: 'path', path: '/pages/page1' });
    expect(contentDestination('companybot://record/record1')).toEqual({ kind: 'path', path: '/record/record1' });
  });
  it('rejects executable schemes, protocol-relative links and encoded path traversal', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', '//outside.example', '#/pages/%2e%2e', '#/chat/a%2fb', '#/pages/%', 'https:\n//example.com']) expect(() => contentDestination(url)).toThrow();
    expect(contentDestination('https://example.com')).toEqual({ kind: 'external', url: 'https://example.com' });
  });
});
