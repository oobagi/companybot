import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { MESSAGE_PAGE } from '@companybot/core/chat';
import { useCallback, useMemo } from 'react';
import { api } from '@/lib/api';
import { usePaginatedQuery } from '@/lib/convex';
import { orderedMessages } from './pagination';

export function useMessages(chatId: Id<'chats'>, threadId?: Id<'chatMessages'>) {
  const { results, status, loadMore } = usePaginatedQuery(api.messages.page, { chatId, threadId }, { initialNumItems: MESSAGE_PAGE });
  const messages = useMemo(() => status === 'LoadingFirstPage' ? undefined : orderedMessages(results, threadId), [results, status, threadId]);
  const more = useCallback(() => { if (status === 'CanLoadMore') loadMore(MESSAGE_PAGE); }, [loadMore, status]);
  return { messages, status, more };
}
