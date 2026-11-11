// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { changeDraft, readDraft, sendChatDraft, useChatDraft } from './drafts';
import { serializeDraft } from './draftStorage';

const disk = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: disk }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: HTMLDivElement;
let current: ReturnType<typeof useChatDraft>;
function Probe({ draftKey }: { draftKey: string }) {
  const draft = useChatDraft(draftKey);
  useEffect(() => { current = draft; }, [draft]);
  return null;
}
async function mount(draftKey: string) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(Probe, { draftKey })));
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; vi.clearAllMocks(); });

it('does not overwrite an unread saved message after a storage read failure', async () => {
  const key = 'failed-chat-draft-read';
  const original = { text: '@Alex Unsent message', mentions: [{ id: 'alex', name: 'Alex', kind: 'user' as const, start: 0, end: 5 }], files: [{ key: 'report', name: 'report.pdf', file: 'storage-id' as Id<'_storage'>, uploadedAt: Date.now() }], ready: true };
  const saved = serializeDraft(original, Date.now());
  let stored = saved;
  disk.getItem.mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
  disk.setItem.mockImplementation(async (_key: string, value: string) => { stored = value; });
  await mount(key);
  expect(current.ready).toBe(false);
  await act(async () => changeDraft(key, d => ({ ...d, text: 'Replacement' })));
  expect(disk.setItem).not.toHaveBeenCalled();
  expect(stored).toBe(saved);
  expect(readDraft(key).text).toBe('');
  expect(current.loadError).toBeDefined();
  const send = vi.fn();
  expect(await sendChatDraft(key, send)).toBe(false);
  expect(send).not.toHaveBeenCalled();

  disk.getItem.mockRejectedValueOnce(new Error('Still unavailable'));
  await act(async () => current.retryLoad());
  expect(current.ready).toBe(false);
  expect(current.loadError).toBeDefined();
  expect(stored).toBe(saved);

  disk.getItem.mockResolvedValueOnce(stored);
  await act(async () => current.retryLoad());
  expect(current.ready).toBe(true);
  expect(current.loadError).toBeUndefined();
  expect(current.text).toBe(original.text);
  expect(current.files).toEqual(original.files);
  expect(current.mentions).toEqual(original.mentions);
  await act(async () => changeDraft(key, draft => ({ ...draft, text: `${draft.text} continued` })));
  expect(JSON.parse(stored).text).toBe(`${original.text} continued`);
});

it('keeps a retried draft read in its original conversation after navigation', async () => {
  disk.getItem.mockRejectedValueOnce(new Error('Unavailable'));
  await mount('draft-read-old-chat');
  let finish!: (value: string) => void;
  disk.getItem.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  await act(async () => current.retryLoad());
  disk.getItem.mockResolvedValueOnce('New chat draft');
  await act(async () => root!.render(createElement(Probe, { draftKey: 'draft-read-new-chat' })));
  expect(current.text).toBe('New chat draft');
  await act(async () => finish('Old chat draft'));
  expect(current.text).toBe('New chat draft');
  expect(readDraft('draft-read-old-chat').text).toBe('Old chat draft');
  expect(disk.setItem).not.toHaveBeenCalled();
});
