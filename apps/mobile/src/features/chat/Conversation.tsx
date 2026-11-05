import { usePinAction } from '@/features/pins/usePins';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { MESSAGE_PAGE } from '@companybot/core/chat';
import { Stack as RouterStack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, FlatList, ScrollView, View } from 'react-native';
import { Button, Card, EmptyState, ErrorState, Loading, Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, useQuery, useWorkspace } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import type { Action } from '@/components/ui/ActionMenu';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import { Composer } from './Composer';
import { MessageRow } from './MessageRow';
import { PendingMessageRow } from './PendingMessageRow';
import { chatTitle, type Message } from './types';
import { canWriteChat } from './access';
import { messageTimeline } from './dates';
import { useMessages } from './useMessages';
import { MESSAGE_SEEK_BATCH, messageSeekState } from './pagination';
import { ChatActivity } from './ChatActivity';
import { useTypingPeople } from './useTypingPeople';

export function Conversation({ chatId, threadId }: { chatId: Id<'chats'>; threadId?: Id<'chatMessages'> }) {
  const workspace = useWorkspace();
  return <OpenConversation key={`${workspace?.id}:${chatId}:${threadId ?? 'main'}`} chatId={chatId} threadId={threadId} />;
}

function OpenConversation({ chatId, threadId }: { chatId: Id<'chats'>; threadId?: Id<'chatMessages'> }) {
  const pin = usePinAction(`chat:${chatId}`);
  const params = useLocalSearchParams<{ messageId?: string }>();
  const messageId = typeof params.messageId === 'string' ? params.messageId : undefined;
  const chat = useQuery(api.chats.get, { chatId });
  const { messages, status, more } = useMessages(chatId, threadId);
  const markRead = useMutation(api.chats.markRead);
  const list = useQuery(api.chats.list);
  const createSide = useMutation(api.chats.createSideChat);
  const task = useTask();
  const { spacing } = useTheme();
  const [liveVisible, setLiveVisible] = useState<ReadonlySet<string>>(() => new Set());
  const streamVisibility = useCallback((id: string, visible: boolean) => setLiveVisible(previous => {
    if (previous.has(id) === visible) return previous;
    const next = new Set(previous); if (visible) next.add(id); else next.delete(id); return next;
  }), []);
  const { data, days } = useMemo(() => messageTimeline(messages ?? [], liveVisible), [messages, liveVisible]);
  const timeline = useRef<FlatList<Message>>(null);
  const focused = useRef<string | undefined>(undefined);
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const userScrolled = useRef(false);
  const [seekBudget, setSeekBudget] = useState({ target: messageId, limit: MESSAGE_SEEK_BATCH });
  const seekLimit = seekBudget.target === messageId ? seekBudget.limit : MESSAGE_SEEK_BATCH;
  const [seekPages, setSeekPages] = useState({ target: messageId, count: 0 });
  const requested = seekPages.target === messageId ? seekPages.count * MESSAGE_PAGE : 0;
  const targetIndex = messageId ? data.findIndex((m) => m._id === messageId) : -1;
  const seek = messageSeekState(messageId, targetIndex >= 0, Math.max(messages?.length ?? 0, requested), status, seekLimit);
  useEffect(() => {
    if (seek !== 'loading' || status !== 'CanLoadMore') return;
    // Paint the loading state before beginning the next bounded history request.
    const frame = requestAnimationFrame(() => {
      // Filtered pages can be empty; bound requests as well as visible rows.
      setSeekPages(previous => ({ target: messageId, count: previous.target === messageId ? previous.count + 1 : 1 }));
      more();
    });
    return () => cancelAnimationFrame(frame);
  }, [seek, status, more, messageId]);
  useEffect(() => {
    focused.current = undefined; retries.current = 0;
    clearTimeout(retryTimer.current);
  }, [messageId]);
  const scrollToTarget = useCallback(() => { if (targetIndex >= 0) timeline.current?.scrollToIndex({ index: targetIndex, viewPosition: 0.5, animated: false }); }, [targetIndex]);
  useEffect(() => {
    const key = `${chatId}:${messageId}`;
    if (!chat || !messageId || targetIndex < 0 || focused.current === key) return;
    const frame = requestAnimationFrame(() => {
      if (!timeline.current) return;
      focused.current = key; retries.current = 0;
      scrollToTarget();
    });
    return () => cancelAnimationFrame(frame);
  }, [chat, chatId, messageId, targetIndex, scrollToTarget]);
  useEffect(() => () => clearTimeout(retryTimer.current), []);
  const unread = !!chat && (chat.unread || chat.mentioned);
  const lastMessageAt = chat?.lastMessageAt;
  useFocusEffect(useCallback(() => {
    const read = () => { if (unread && lastMessageAt !== undefined && AppState.currentState === 'active') void markRead({ chatId }).catch(() => {}); };
    read();
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') read(); });
    return () => listener.remove();
  }, [unread, lastMessageAt, chatId, markRead]));
  if (chat === undefined) return <Screen><Loading label="Opening conversation…" /></Screen>;
  if (!chat) return <Screen><EmptyState title="Chat not found" description="It may have been deleted, or you no longer have access." /></Screen>;
  const parent = threadId ? messages?.find(message => message._id === threadId) : undefined;
  const readonlyThread = !!parent && (!!parent.ask || parent.threadId !== null);
  const writable = canWriteChat(chat, readonlyThread);
  const main = chat.parentId ?? chat._id;
  const sides = list?.dms.filter((d) => d.parentId === main) ?? [];
  const actions: Action[] = [
    { id: 'details', title: 'Conversation details', icon: 'info.circle' },
    { id: 'pin', title: pin.label, icon: 'pin', disabled: pin.disabled },
    ...(!threadId && chat.agentId ? [
      { id: 'new', title: 'New chat', icon: 'square.and.pencil' as const, disabled: task.busy || !writable },
      { id: 'switch', title: 'Switch chat', icon: 'bubble.left.and.bubble.right' as const, items: [
        { id: `chat:${main}`, title: 'Main conversation', selected: chat._id === main },
        ...sides.map(side => ({ id: `chat:${side._id}`, title: side.label ?? 'New chat', selected: side._id === chatId })),
      ] },
    ] : []),
  ];
  const perform = (action: string) => {
    if (action === 'pin') pin.onPress();
    else if (action === 'details') router.push({ pathname: '/chat/[chatId]/details', params: { chatId } });
    else if (action.startsWith('chat:')) router.replace({ pathname: '/chat/[chatId]', params: { chatId: action.slice(5) } });
    else if (action === 'new' && writable) void task.run(async () => { const id = await createSide({ parentId: main }); router.push({ pathname: '/chat/[chatId]', params: { chatId: id } }); });
  };
  return <Screen keyboard padded={false}>
    <RouterStack.Screen options={{ title: threadId ? 'Thread' : chatTitle(chat) }} />
    <HeaderMenu label="Conversation actions" actions={actions} onAction={perform} />
    {chat.topic && <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm }}><Text variant="supporting" tone="muted" numberOfLines={2}>{chat.topic}</Text></View>}
    {task.error && <ErrorState message={task.error} />}
    {pin.error && <ErrorState message={pin.error} />}
    {seek === 'loading' && <Loading layout="inline" label="Looking for this message…" />}
    {seek === 'continue' && <Card><Text tone="muted">This message is older than the history loaded so far.</Text><Button label="Continue looking" variant="secondary" onPress={() => setSeekBudget({ target: messageId, limit: Math.max(seekLimit, messages?.length ?? 0) + MESSAGE_SEEK_BATCH })} /></Card>}
    {seek === 'missing' && <Card><Text tone="muted">This message is no longer available in this conversation.</Text></Card>}
    {messages === undefined || !messages.length ? <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      {messages === undefined ? <Loading label="Loading messages…" /> : <EmptyState title={threadId ? 'Thread not found' : 'No messages yet'} description={threadId ? 'This thread is no longer available.' : `Start a conversation in ${chatTitle(chat)}.`} />}
    </ScrollView> : <FlatList ref={timeline} data={data} inverted keyExtractor={(m) => m._id} renderItem={({ item }) => item.sending ? <PendingMessageRow name={item.author.name} image={item.author.image} text={item.text} files={item.sending.files} dayLabel={days.get(item._id)} /> : <MessageRow row={item} highlighted={item._id === messageId} readOnly={!writable} inThread={!!threadId} dayLabel={days.get(item._id)} onStreamVisibility={streamVisibility} />} onScrollToIndexFailed={({ index, averageItemLength }) => { if (retries.current++ >= 3) return; timeline.current?.scrollToOffset({ offset: index * averageItemLength, animated: false }); clearTimeout(retryTimer.current); retryTimer.current = setTimeout(scrollToTarget, 150); }} onScrollBeginDrag={() => { userScrolled.current = true; }} onEndReached={() => { if (userScrolled.current && status === 'CanLoadMore' && seek !== 'loading' && seek !== 'continue') { userScrolled.current = false; more(); } }} onEndReachedThreshold={0.3} ListFooterComponent={status === 'LoadingMore' ? <Loading layout="inline" label="Loading older messages…" /> : status === 'CanLoadMore' ? <Button label="Load older messages" variant="ghost" onPress={more} /> : undefined} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }} initialNumToRender={16} maxToRenderPerBatch={12} windowSize={9} contentContainerStyle={{ paddingVertical: spacing.md }} />}
    <TypingStatus chatId={chatId} threadId={threadId} />
    {chat.trash ? <Card><Text>This conversation is in Archive.</Text><Button label="Open Archive" variant="secondary" onPress={() => router.push('/settings/archive')} /></Card> : readonlyThread ? <Card><Text tone="muted">This is a read-only conversation between agents.</Text></Card> : !chat.canPost ? <Card><Text tone="muted">You have view-only access to this conversation.</Text></Card> : messages !== undefined && (!threadId || messages.length > 0) && <Composer key={`${chatId}:${threadId ?? 'main'}`} chatId={chatId} threadId={threadId} />}
  </Screen>;
}

const noPeople: never[] = [];
function TypingStatus({ chatId, threadId }: { chatId: Id<'chats'>; threadId?: Id<'chatMessages'> }) {
  const typing = useQuery(api.typing.list, { chatId, threadId });
  const stop = useMutation(api.turns.stop);
  const task = useTask();
  const people = useTypingPeople(typing?.people ?? noPeople);
  return <ChatActivity people={people} agents={typing?.agents ?? []} busy={task.busy} error={task.error} onStop={turnId => { const agent = typing?.agents.find(value => value.turnId === turnId); if (agent?.canStop && !agent.stopping) void task.run(() => stop({ turnId: agent.turnId })); }} />;
}
