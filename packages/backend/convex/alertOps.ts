import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { latestMentionSince, shownAt } from './chatOps';
import { memberOf, preferencesOf } from './lib';
import { STALE_TURN_MS } from './turns';

/** Shared desktop alerts and native badge semantics: one unread alert per visible chat. */
export async function alertMessages(ctx: QueryCtx, userId: Id<'users'>, workspaceId?: Id<'workspaces'>) {
  const notify = (await preferencesOf(ctx, userId))?.notify ?? 'all';
  const alerts: { chat: Doc<'chats'>; message: Doc<'chatMessages'> }[] = [];
  if (notify === 'off') return alerts;
  const access = new Map<Id<'workspaces'>, boolean>();
  for await (const seat of ctx.db.query('chatMembers').withIndex('by_user', q => q.eq('userId', userId))) {
    const chat = await ctx.db.get(seat.chatId);
    if (!chat || chat.archived || seat.workspaceId !== chat.workspaceId || (workspaceId && chat.workspaceId !== workspaceId)) continue;
    if (!access.has(chat.workspaceId)) access.set(chat.workspaceId, !!await memberOf(ctx, userId, chat.workspaceId));
    if (!access.get(chat.workspaceId)) continue;
    const since = seat.lastReadAt ?? 0;
    const fromOthers = (message: Doc<'chatMessages'> | null) => message && !message.deleted && !message.quiet && message.authorUserId !== userId ? message : null;
    // A thread mention does not advance chat.lastMessageAt: its own index must be consulted.
    const mention = await latestMentionSince(ctx, chat._id, userId, since);
    let message = fromOthers(mention ? await ctx.db.get(mention.messageId) : null);
    if (chat.kind === 'dm' && notify === 'all' && chat.lastMessageAt > since) {
      const recent = await ctx.db.query('chatMessages').withIndex('by_chat_thread', q => q.eq('chatId', chat._id).eq('threadId', undefined).gt('_creationTime', since - STALE_TURN_MS)).order('desc').take(20);
      const newest = recent.map(fromOthers).filter(m => m?.status === 'done' && shownAt(m) > since).reduce<Doc<'chatMessages'> | null>((a, m) => a && shownAt(a) >= shownAt(m!) ? a : m, null);
      if (newest && (!message || shownAt(newest) > shownAt(message))) message = newest;
    }
    if (message) alerts.push({ chat, message });
  }
  return alerts;
}

export async function alertCount(ctx: QueryCtx, userId: Id<'users'>) {
  return (await alertMessages(ctx, userId)).length;
}
