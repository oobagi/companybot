import { describe, expect, it } from 'vitest';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { deserializeDraft, serializeDraft, type Draft } from './draftStorage';

const now = 1_000_000_000;
const draft: Draft = { text: '@Alex hello', mentions: [{ id: 'alex-two', kind: 'user', name: 'Alex', start: 0, end: 5 }], files: [{ key: 'upload', name: 'Report.pdf', file: 'file-a' as Id<'_storage'>, uploadedAt: now - 1000 }], ready: true };
describe('mobile draft persistence', () => {
  it('round trips picked identities and ready attachments across restarts', () => {
    expect(deserializeDraft(serializeDraft(draft, now), now + 100)).toEqual(draft);
  });
  it('drops expired uploads but keeps recent text and identities', () => {
    const loaded = deserializeDraft(serializeDraft(draft, now), now + 86_400_000);
    expect(loaded.files).toEqual([]);
    expect(loaded.text).toBe(draft.text);
    expect(loaded.mentions).toEqual(draft.mentions);
  });
  it('does not resurrect uploading files with no server ID', () => {
    const loaded = deserializeDraft(serializeDraft({ ...draft, files: [{ key: 'pending', name: 'Photo.jpg' }] }, now), now);
    expect(loaded.files).toEqual([]);
  });
  it('keeps legacy plain text and rejects corrupt identity ranges', () => {
    expect(deserializeDraft('unfinished text', now).text).toBe('unfinished text');
    const bad = JSON.stringify({ companybotDraft: 1, savedAt: now, text: 'hello', mentions: [{ ...draft.mentions[0], start: -5, end: 0 }], files: [] });
    expect(deserializeDraft(bad, now).mentions).toEqual([]);
  });
  it('expires drafts older than thirty days', () => {
    expect(deserializeDraft(serializeDraft(draft, now), now + 31 * 86_400_000).text).toBe('');
  });
});
