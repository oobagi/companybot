import { describe, expect, it } from 'vitest';
import type { OptimisticLocalStore } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { api } from '@/lib/api';
import { orderedMessages } from './pagination';
import { showSending } from './showSending';
import type { Message } from './types';

const page = (workspaceId = 'w', chatId = 'chat', threadId?: string, cursor: string | null = null) => ({ args: { workspaceId, chatId, threadId, paginationOpts: { cursor, numItems: 50 } }, value: { page: [] as Message[], isDone: false, continueCursor: 'older' } });

describe('pending timeline messages', () => {
  it('keeps a pending send by the composer despite clock skew, after the pinned thread parent', () => {
    const pending = { _id: 'pending', shownAt: 100, sending: { files: 0 } };
    const reply = { _id: 'reply', shownAt: 200 };
    const parent = { _id: 'parent', shownAt: 300 };
    expect(orderedMessages([pending, reply, parent], 'parent').map(row => row._id)).toEqual(['parent', 'reply', 'pending']);
  });
  it('overlays only matching newest pages and deduplicates split pages without mutating their base', () => {
    const pages = [page(), page(), page('w', 'chat', undefined, 'older'), page('w', 'chat', 'thread'), page('w', 'other'), page('other')];
    const changed = new Map<object, typeof pages[number]['value']>();
    const store = {
      getAllQueries: () => pages,
      getQuery: () => ({ members: [{ isYou: true, userId: 'user', name: 'You', email: '', image: null }] }),
      setQuery: (_query: unknown, args: object, value: typeof pages[number]['value']) => changed.set(args, value),
    } as unknown as OptimisticLocalStore;
    showSending(store, { workspaceId: 'w', chatId: 'chat', text: ' Hello ', attachments: ['attachment'] } as FunctionArgs<typeof api.messages.send>);
    expect([...changed.keys()]).toEqual([pages[0].args, pages[1].args]);
    const rows = orderedMessages([...changed.values()].flatMap(value => value.page));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'Hello', mine: true, threadId: null, sending: { files: 1 } });
    expect(pages.every(query => query.value.page.length === 0)).toBe(true);
    // These are overlays only; the unmodified server page is authoritative after rollback/commit.
    expect(orderedMessages(pages.flatMap(query => query.value.page))).toEqual([]);
  });
});
