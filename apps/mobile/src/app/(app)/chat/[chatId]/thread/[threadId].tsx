import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { useLocalSearchParams } from 'expo-router';
import { Conversation } from '@/features/chat/Conversation';
export default function Route() { const { chatId, threadId } = useLocalSearchParams<{ chatId: Id<'chats'>; threadId: Id<'chatMessages'> }>(); return <Conversation chatId={chatId} threadId={threadId} />; }
