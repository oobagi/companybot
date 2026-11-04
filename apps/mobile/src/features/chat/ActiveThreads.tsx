import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { EmptyState, Field, ListRow, Loading, Section, Stack, Text } from '@/components/ui';
import { Dialog } from './Dialog';

const clock = () => Math.floor(Date.now() / 300_000) * 300_000;
export function ActiveThreads({ onClose }: { onClose: () => void }) {
  const [now, setNow] = useState(clock);
  const [search, setSearch] = useState('');
  const threads = useQuery(api.chats.activeThreads, { now });
  const chats = useQuery(api.chats.list);
  useFocusEffect(useCallback(() => { const timer = setInterval(() => setNow(clock()), 60_000); return () => clearInterval(timer); }, []));
  const visible = threads?.filter(thread => thread.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => b.lastReplyAt - a.lastReplyAt);
  return <Dialog title="Active threads" onClose={onClose}><Stack style={{ flexGrow: 1 }}><Field label="Search threads" value={search} onChangeText={setSearch} />
    <Text tone="muted">Recent conversations in channels you have joined.</Text>
    {visible === undefined ? <Loading /> : !visible.length ? <EmptyState title="No active threads" description="Threads with recent replies appear here." /> : <Section>{visible.map(thread => <ListRow key={thread.messageId} title={thread.title} description={`#${chats?.channels.find(chat => chat._id === thread.chatId)?.name ?? 'Channel'} · ${new Date(thread.lastReplyAt).toLocaleString()}`} onPress={() => { onClose(); router.push({ pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: thread.chatId, threadId: thread.messageId } }); }} />)}</Section>}
  </Stack></Dialog>;
}
