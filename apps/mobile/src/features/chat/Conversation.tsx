import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { TYPING_MS } from '@companybot/core/typing';
import { Stack as RouterStack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, View } from 'react-native';
import { Button, Card, EmptyState, ErrorState, Loading, Screen, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import type { Action } from '@/components/ui/ActionMenu';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import { Composer } from './Composer';
import { MessageRow } from './MessageRow';
import { chatTitle, type Message } from './types';

export function Conversation({ chatId, threadId }: { chatId: Id<'chats'>; threadId?: Id<'chatMessages'> }) {
  const params = useLocalSearchParams<{ messageId?: string }>();
  const messageId = typeof params.messageId === 'string' ? params.messageId : undefined;
  const chat = useQuery(api.chats.get, { chatId });
  const messages = useQuery(api.messages.list, { chatId, threadId });
  const markRead = useMutation(api.chats.markRead);
  const list = useQuery(api.chats.list);
  const createSide = useMutation(api.chats.createSideChat);
  const task = useTask();
  const { spacing } = useTheme();
  const data = useMemo(() => messages?.slice().reverse() ?? [], [messages]);
  const timeline = useRef<FlatList<Message>>(null);
  const focused = useRef<string | undefined>(undefined);
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const targetIndex = messageId ? data.findIndex((m) => m._id === messageId) : -1;
  const scrollToTarget = useCallback(() => { if (targetIndex >= 0) timeline.current?.scrollToIndex({ index: targetIndex, viewPosition: 0.5, animated: false }); }, [targetIndex]);
  useEffect(() => {
    const key = `${chatId}:${messageId}`;
    if (!messageId || targetIndex < 0 || focused.current === key) return;
    focused.current = key; retries.current = 0;
    const frame = requestAnimationFrame(scrollToTarget);
    return () => cancelAnimationFrame(frame);
  }, [chatId, messageId, targetIndex, scrollToTarget]);
  useEffect(() => () => clearTimeout(retryTimer.current), []);
  const unread = !!chat && (chat.unread || chat.mentioned);
  const lastMessageAt = chat?.lastMessageAt;
  useFocusEffect(useCallback(() => {
    const read = () => { if (unread && lastMessageAt !== undefined && AppState.currentState === 'active') void markRead({ chatId }).catch(() => {}); };
    read();
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') read(); });
    return () => listener.remove();
  }, [unread, lastMessageAt, chatId, markRead]));
  if (chat === undefined) return <Loading label="Opening conversation…" />;
  if (!chat) return <EmptyState title="Chat not found" description="It may have been deleted, or you no longer have access." />;
  const readonlyThread = !!threadId && (!!messages?.[0]?.ask || messages?.[0]?.threadId !== null);
  const main = chat.parentId ?? chat._id;
  const sides = list?.dms.filter((d) => d.parentId === main) ?? [];
  const actions: Action[] = [
    { id: 'details', title: 'Conversation details', icon: 'info.circle' },
    ...(!threadId && chat.agentId ? [
      { id: 'new', title: 'New chat', icon: 'square.and.pencil' as const, disabled: task.busy },
      { id: 'switch', title: 'Switch chat', icon: 'bubble.left.and.bubble.right' as const, items: [
        { id: `chat:${main}`, title: 'Main conversation', selected: chat._id === main },
        ...sides.map(side => ({ id: `chat:${side._id}`, title: side.label ?? 'New chat', selected: side._id === chatId })),
      ] },
    ] : []),
  ];
  const perform = (action: string) => {
    if (action === 'details') router.push({ pathname: '/chat/[chatId]/details', params: { chatId } });
    else if (action.startsWith('chat:')) router.replace({ pathname: '/chat/[chatId]', params: { chatId: action.slice(5) } });
    else if (action === 'new') void task.run(async () => { const id = await createSide({ parentId: main }); router.push({ pathname: '/chat/[chatId]', params: { chatId: id } }); });
  };
  return <Screen keyboard padded={false}>
    <RouterStack.Screen options={{ title: threadId ? 'Thread' : chatTitle(chat) }} />
    <HeaderMenu label="Conversation actions" actions={actions} onAction={perform} />
    {chat.topic && <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}><Text variant="caption" tone="muted">{chat.topic}</Text></View>}
    {task.error && <ErrorState message={task.error} />}
    {messageId && messages !== undefined && targetIndex < 0 && <Card><Text tone="muted">This message is not in the most recent 200 messages.</Text></Card>}
    {messages === undefined ? <Loading label="Loading messages…" /> : !messages.length ? <EmptyState title={threadId ? 'Thread not found' : 'No messages yet'} description={threadId ? 'This thread is no longer available.' : `Start a conversation in ${chatTitle(chat)}.`} /> : <FlatList ref={timeline} data={data} inverted keyExtractor={(m) => m._id} renderItem={({ item }) => <MessageRow row={item} highlighted={item._id === messageId} readOnly={!!chat.trash || readonlyThread} inThread={!!threadId} />} onScrollToIndexFailed={({ index, averageItemLength }) => { if (retries.current++ >= 3) return; timeline.current?.scrollToOffset({ offset: index * averageItemLength, animated: false }); clearTimeout(retryTimer.current); retryTimer.current = setTimeout(scrollToTarget, 150); }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }} initialNumToRender={16} maxToRenderPerBatch={12} windowSize={9} contentContainerStyle={{ paddingVertical: spacing.md }} />}
    <TypingStatus chatId={chatId} threadId={threadId} />
    {chat.trash ? <Card><Text>This conversation is in Archive.</Text><Button label="Open Archive" variant="secondary" onPress={() => router.push('/settings/archive')} /></Card> : readonlyThread ? <Card><Text tone="muted">This is a read-only conversation between agents.</Text></Card> : messages !== undefined && (!threadId || messages.length > 0) && <Composer key={`${chatId}:${threadId ?? 'main'}`} chatId={chatId} threadId={threadId} />}
  </Screen>;
}

function TypingStatus({ chatId, threadId }: { chatId: Id<'chats'>; threadId?: Id<'chatMessages'> }) {
  const typing = useQuery(api.typing.list, { chatId, threadId });
  const stop = useMutation(api.turns.stop);
  const { spacing } = useTheme();
  const task = useTask();
  if (!typing?.people.length && !typing?.agents.length) return null;
  return <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}>
    {typing?.agents.map((agent) => <Stack horizontal key={agent.turnId}><Text variant="caption" tone="muted" style={{ flex: 1 }}>{agent.name}: {agent.step ?? 'Writing…'}</Text>{agent.canStop && <Button label={agent.stopping ? 'Stopping…' : 'Stop'} variant="ghost" disabled={agent.stopping || task.busy} onPress={() => void task.run(() => stop({ turnId: agent.turnId }))} />}</Stack>)}
    {typing?.people.map((person) => <PersonTyping key={`${person.id}:${person.at}`} name={person.name} />)}
    {task.error && <ErrorState message={task.error} />}
  </View>;
}

/** Each new server ping remounts its timer, independent of device/server clock skew. */
function PersonTyping({ name }: { name: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => { const timer = setTimeout(() => setVisible(false), TYPING_MS); return () => clearTimeout(timer); }, []);
  return visible ? <Text variant="caption" tone="muted">{name} is typing…</Text> : null;
}
