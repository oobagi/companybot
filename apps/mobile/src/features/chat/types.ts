import type { FunctionReturnType } from 'convex/server';
import { api } from '@/lib/api';

export type ChatList = NonNullable<FunctionReturnType<typeof api.chats.list>>;
export type Chat = NonNullable<FunctionReturnType<typeof api.chats.get>>;
export type Message = FunctionReturnType<typeof api.messages.page>['page'][number];
export const chatTitle = (chat: Pick<Chat, 'kind' | 'name' | 'title' | 'label'>) => chat.label ?? (chat.kind === 'channel' ? `#${chat.name}` : chat.title);
