import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { useLocalSearchParams } from 'expo-router';
import { ChatDetails } from '@/features/chat/ChatDetails';
export default function Route() { const { chatId } = useLocalSearchParams<{ chatId: Id<'chats'> }>(); return <ChatDetails chatId={chatId} />; }
