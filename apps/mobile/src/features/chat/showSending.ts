import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import type { OptimisticUpdate } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { api } from '@/lib/api';
import type { Message } from './types';

/** Convex replaces this overlay atomically with committed queries, or rolls it back on failure. */
export const showSending: OptimisticUpdate<FunctionArgs<typeof api.messages.send>> = (store, { workspaceId, chatId, threadId, text, attachments = [] }) => {
  const newest = store.getAllQueries(api.messages.page).filter(({ args, value }) => value && args.workspaceId === workspaceId && args.chatId === chatId && args.threadId === threadId && args.paginationOpts.cursor === null);
  const me = store.getQuery(api.workspace.team, { workspaceId })?.members.find(member => member.isYou);
  if (!newest.length || !me) return;
  const now = Date.now();
  const shownAt = Math.max(now, ...newest.flatMap(query => query.value!.page.map(row => row.shownAt)));
  const message: Message = {
    // One in-flight send per scoped draft. A stable identity survives optimistic replays and split pages.
    _id: `sending:${chatId}:${threadId ?? 'main'}` as Id<'chatMessages'>,
    _creationTime: now, shownAt, chatId, threadId: threadId ?? null,
    author: { type: 'user', id: me.userId, name: me.name || me.email, image: me.image },
    text: text.trim(), parts: [], status: 'done', error: null, stoppedBy: null, stats: null,
    editedAt: null, deleted: false, mine: true, replyCount: 0, lastReplyAt: null, replyAuthors: [],
    reactions: [], automation: null, attachments: [], linkPreviews: [], pause: null, ask: null,
    sending: { files: attachments.length },
  };
  for (const { args, value } of newest) store.setQuery(api.messages.page, args, { ...value!, page: [...value!.page, message] });
};
