import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { useLocalSearchParams } from 'expo-router';
import { Conversation } from '@/features/chat/Conversation';
export default function Route() { const { chatId } = useLocalSearchParams<{ chatId: Id<'chats'> }>(); return <Conversation chatId={chatId} />; }
