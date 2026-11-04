import { describe, expect, it } from 'vitest';
import { canShareReply, canWriteChat, effectivePrivacy } from './access';

describe('chat access', () => {
  it('requires an affirmative server posting grant and keeps archived/agent threads read-only', () => {
    expect(canWriteChat({ canPost: true })).toBe(true);
    expect(canWriteChat({ canPost: false })).toBe(false);
    expect(canWriteChat({})).toBe(false);
    expect(canWriteChat({ canPost: true, trash: {} })).toBe(false);
    expect(canWriteChat({ canPost: true }, true)).toBe(false);
  });
  it('offers disclosure only for a visible completed reply with server permission', () => {
    const reply = { status: 'done', deleted: false, privacy: { hidden: false, share: 'Share only the answer?' } };
    expect(canShareReply(reply, false)).toBe(true);
    expect(canShareReply({ ...reply, privacy: { ...reply.privacy, hidden: true } }, false)).toBe(false);
    expect(canShareReply({ ...reply, privacy: { ...reply.privacy, share: null } }, false)).toBe(false);
    expect(canShareReply({ ...reply, status: 'streaming' }, false)).toBe(false);
    expect(canShareReply({ ...reply, deleted: true }, false)).toBe(false);
    expect(canShareReply(reply, true)).toBe(false);
  });
  it('does not let a stale stream undo a newly revoked source grant', () => {
    const hidden = { hidden: true, label: 'Only Office can see this', why: null, share: null, sharedBy: null };
    const visible = { ...hidden, hidden: false, why: 'Uses Deals', share: 'Share?' };
    expect(effectivePrivacy(hidden, visible)).toEqual(hidden);
    expect(effectivePrivacy(visible, hidden)).toEqual(hidden);
    expect(effectivePrivacy(hidden, undefined)).toEqual(hidden);
  });
});
