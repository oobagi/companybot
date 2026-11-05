import { describe, expect, it } from 'vitest';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { deserializeDraft, serializeDraft, type Draft } from './draftStorage';
import { deliverDraft } from './sendDraft';

const initial = (): Draft => ({ ready: true, text: 'Keep the attached report', mentions: [], files: [{ key: 'report', name: 'report.pdf', file: 'storage' as Id<'_storage'>, uploadedAt: 1000 }] });
function fixture() {
  const rows = new Map<string, Draft>();
  const store = { read: (key: string) => rows.get(key)!, write: (key: string, draft: Draft) => { rows.set(key, draft); } };
  return { rows, store };
}
const deferred = () => { let resolve!: () => void; let reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('outgoing draft lifecycle', () => {
  it('keeps the draft recoverable and prevents a second composer sending its attachments again', async () => {
    const { rows, store } = fixture(); const original = initial(); rows.set('workspace:chat:main', original);
    const request = deferred(); let calls = 0;
    const send = () => { calls++; return request.promise; };
    const first = deliverDraft(store, 'workspace:chat:main', send);
    expect(rows.get('workspace:chat:main')?.sending).toBe(true);
    expect(deserializeDraft(serializeDraft(rows.get('workspace:chat:main')!, 2000), 2000)).toEqual(original);
    expect(await deliverDraft(store, 'workspace:chat:main', send)).toBe(false);
    expect(calls).toBe(1);
    request.reject(new Error('Offline'));
    expect(await first).toBe(false);
    expect(rows.get('workspace:chat:main')).toEqual({ ...original, sendError: 'Offline' });
    expect(await deliverDraft(store, 'workspace:chat:main', async draft => { expect(draft.files).toEqual(original.files); })).toBe(true);
    expect(rows.get('workspace:chat:main')).toMatchObject({ text: '', files: [], mentions: [], sending: undefined, sendError: undefined });
  });
  it('settles only the originating workspace and thread, even after navigating elsewhere', async () => {
    const { rows, store } = fixture();
    for (const key of ['a:chat:main', 'a:chat:reply', 'b:chat:main']) rows.set(key, initial());
    const one = deferred(); const two = deferred();
    const sending = deliverDraft(store, 'a:chat:main', () => one.promise);
    const reply = deliverDraft(store, 'a:chat:reply', () => two.promise);
    one.resolve(); await sending;
    expect(rows.get('a:chat:main')?.text).toBe('');
    expect(rows.get('a:chat:reply')?.sending).toBe(true);
    expect(rows.get('b:chat:main')).toEqual(initial());
    two.reject(new Error('No access')); await reply;
    expect(rows.get('a:chat:reply')?.files).toEqual(initial().files);
  });
  it('does not erase a replacement draft when an old request settles', async () => {
    const { rows, store } = fixture(); rows.set('chat', initial());
    const request = deferred(); const sending = deliverDraft(store, 'chat', () => request.promise);
    const replacement = { ...initial(), text: 'A different draft' }; rows.set('chat', replacement);
    request.resolve(); await sending;
    expect(rows.get('chat')).toBe(replacement);
  });
  it('does not submit empty, unloaded, uploading or failed-upload drafts', async () => {
    const { rows, store } = fixture(); let calls = 0;
    const incomplete: Draft[] = [{ ...initial(), ready: false }, { ...initial(), text: ' ', files: [] }, { ...initial(), files: [{ key: 'upload', name: 'report.pdf' }] }, { ...initial(), files: [{ key: 'failed', name: 'report.pdf', error: 'Upload failed' }] }];
    for (const value of incomplete) { rows.set('chat', value); expect(await deliverDraft(store, 'chat', async () => { calls++; })).toBe(false); expect(rows.get('chat')).toBe(value); }
    expect(calls).toBe(0);
  });
});
