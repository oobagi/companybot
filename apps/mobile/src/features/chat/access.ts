import type { Message } from './types';

export const canWriteChat = (chat: { canPost?: boolean; trash?: unknown }, readOnlyThread = false) => chat.canPost === true && !chat.trash && !readOnlyThread;

/** Independent reactive subscriptions can settle on different renders; a denial always wins. */
export const effectivePrivacy = (saved: Message['privacy'], streamed: Message['privacy']) => saved?.hidden ? saved : streamed ?? saved;

export const canShareReply = (message: { privacy?: { hidden: boolean; share: string | null } | null; status: string; deleted: boolean }, readOnly: boolean) =>
  !readOnly && !message.deleted && message.status !== 'streaming' && !!message.privacy?.share && !message.privacy.hidden;
