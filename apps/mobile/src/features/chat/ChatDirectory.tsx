import { ReorderSheet } from '@/features/arrangements/ReorderSheet';
import { useArrangements } from '@/features/arrangements/useArrangements';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { can } from '@companybot/core/permissions';
import { router } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';
import { ChannelIcon, PrivateChannelIcon } from '@/design/icons';
import { useTheme } from '@/design';
import { Avatar, Button, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { DirectoryHeader } from '@/features/session/DirectoryHeader';
import { ActiveThreads } from './ActiveThreads';
import { Dialog } from './Dialog';
import { chatTitle } from './types';

export function ChatDirectory() {
  const { colors, sizes, spacing } = useTheme();
  const chats = useQuery(api.chats.list);
  const arrangements = useArrangements();
  const me = useQuery(api.workspace.me);
  const openDm = useMutation(api.chats.openDm);
  const task = useTask();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<'new' | 'channel' | 'browse' | 'threads' | 'organize'>();
  const open = (chatId: Id<'chats'>) => router.push({ pathname: '/chat/[chatId]', params: { chatId } });
  const matches = (name: string) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  if (chats === undefined || !arrangements.loaded) return <Screen><Loading label="Loading chats…" /></Screen>;
  if (!chats) return <Screen><EmptyState title="Workspace unavailable" /></Screen>;
  const channels = arrangements.order('channels', chats.channels).filter((c) => matches(chatTitle(c)));
  const agents = chats.agents.filter((a) => matches(a.name));
  const dms = chats.dms.filter((c) => (!c.agentId || c.parentId) && matches(chatTitle(c)));
  const rows: ({ key: string; heading: string } | { key: string; title: string; leading: React.ReactNode; unread?: boolean; mentioned?: boolean; onPress: () => void })[] = [
    ...(channels.length ? [{ key: 'channels', heading: 'Channels' }] : []),
    ...channels.map(c => ({ key: c._id, title: c.label ?? c.name ?? chatTitle(c), leading: c.private ? <PrivateChannelIcon size={sizes.icon} color={colors.muted} /> : <ChannelIcon size={sizes.icon} color={colors.muted} />, unread: c.unread, mentioned: c.mentioned, onPress: () => open(c._id) })),
    ...(agents.length || dms.length ? [{ key: 'messages', heading: 'Direct messages' }] : []),
    ...agents.map(a => ({ key: a._id, title: a.name, leading: <Avatar name={a.name} image={a.image} agent />, unread: a.unread, mentioned: a.mentioned, onPress: () => { if (a.dmId) open(a.dmId); else void task.run(async () => open(await openDm({ userIds: [], agentIds: [a._id] }))); } })),
    ...dms.map(c => ({ key: c._id, title: chatTitle(c), leading: <Avatar name={chatTitle(c)} agent={!!c.agentId} />, unread: c.unread, mentioned: c.mentioned, onPress: () => open(c._id) })),
  ];
  return <><DirectoryHeader search={{ placeholder: 'Search chats', value: search, onChange: setSearch }} action={{ label: 'New message', onPress: () => setDialog('new') }} menu={[
    { label: 'Threads', icon: 'bubble.left.and.bubble.right', onPress: () => setDialog('threads') },
    ...(arrangements.writable ? [{ label: 'Organize channels', icon: 'arrow.up.arrow.down' as const, onPress: () => setDialog('organize') }] : []),
    { label: 'Browse channels', icon: 'number', onPress: () => setDialog('browse') },
    ...(me?.access && can(me.access, 'channels.edit') ? [{ label: 'New channel', icon: 'plus' as const, onPress: () => setDialog('channel') }] : []),
  ]} /><Screen nativeScroll padded={false} edges={['left', 'right']}>
    <ScreenList data={rows} keyExtractor={row => row.key} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: sizes.gutter, paddingBottom: spacing.xl }}
      ListHeaderComponent={task.error ? <ErrorState message={task.error} /> : undefined}
      ListEmptyComponent={<EmptyState title={search ? 'No chats found' : 'No conversations yet'} description={search ? 'Try a different name.' : 'Start a conversation with a teammate or agent.'} />}
      renderItem={({ item }) => 'heading' in item
        ? <Text variant="supporting" tone="muted" accessibilityRole="header" style={{ paddingTop: spacing.xl, paddingBottom: spacing.sm, fontWeight: '500' }}>{item.heading}</Text>
        : <ListRow title={item.title} leading={item.leading} accessibilityLabel={`${item.title}${item.mentioned ? ', mentioned you' : item.unread ? ', unread' : ''}`} trailing={item.mentioned ? <Text variant="supporting" tone="link">@</Text> : item.unread ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.text }} /> : undefined} onPress={item.onPress} />} />
    {dialog === 'organize' && <ReorderSheet title="Organize channels" list="channels" items={chats.channels.map(channel => ({ _id: channel._id, title: chatTitle(channel) }))} onClose={() => setDialog(undefined)} />}
    {dialog === 'threads' && <ActiveThreads onClose={() => setDialog(undefined)} />}
    {dialog === 'new' && <NewMessage onClose={() => setDialog(undefined)} onOpen={open} />}
    {dialog === 'channel' && <NewChannel onClose={() => setDialog(undefined)} onOpen={open} />}
    {dialog === 'browse' && <BrowseChannels onClose={() => setDialog(undefined)} onOpen={open} />}
  </Screen></>;
}

function NewMessage({ onClose, onOpen }: { onClose: () => void; onOpen: (id: Id<'chats'>) => void }) {
  const chats = useQuery(api.chats.list);
  const team = useQuery(api.workspace.team);
  const open = useMutation(api.chats.openDm);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const task = useTask();
  const people = [...(team?.members.filter((p) => !p.isYou).map((p) => ({ id: p.userId, name: p.name || p.email, image: p.image, agent: false })) ?? []), ...(chats?.agents.map((a) => ({ id: a._id, name: a.name, image: a.image, agent: true })) ?? [])];
  return <Dialog title="New message" onClose={onClose} busy={task.busy}><Field label="Find people or agents" value={query} onChangeText={setQuery} />
    {people.filter((p) => p.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((p) => <ListRow key={p.id} title={p.name} leading={<Avatar name={p.name} image={p.image} agent={p.agent} />} selected={selected.includes(p.id)} trailing={<Text>{selected.includes(p.id) ? 'Selected' : p.agent ? 'Bot' : ''}</Text>} onPress={() => setSelected((ids) => ids.includes(p.id) ? ids.filter((id) => id !== p.id) : [...ids, p.id])} />)}
    {task.error && <ErrorState message={task.error} />}
    <Button label="Open conversation" disabled={!selected.length} loading={task.busy} onPress={() => void task.run(async () => { const id = await open({ userIds: people.filter((p) => !p.agent && selected.includes(p.id)).map((p) => p.id as Id<'users'>), agentIds: people.filter((p) => p.agent && selected.includes(p.id)).map((p) => p.id as Id<'agents'>) }); onClose(); onOpen(id); })} />
  </Dialog>;
}

function NewChannel({ onClose, onOpen }: { onClose: () => void; onOpen: (id: Id<'chats'>) => void }) {
  const create = useMutation(api.chats.createChannel);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [privateChannel, setPrivate] = useState(false);
  const task = useTask();
  const guard = useDraftGuard({ dirty: !!name || !!topic || privateChannel, busy: task.busy, onClose });
  const save = () => void task.run(async () => { const id = await create({ name: name.trim(), topic: topic.trim(), private: privateChannel }); guard.complete(); onClose(); onOpen(id); });
  return <EditorSheet title="New channel" size="content" onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy} submit={{ label: 'Create', disabled: !name.trim(), onPress: save }}>{guard.dialog}<Field label="Name" value={name} onChangeText={setName} editable={!task.busy} autoCapitalize="none" /><Field label="Topic" value={topic} onChangeText={setTopic} editable={!task.busy} multiline />
    <ListRow title="Private channel" description="Only invited members can read it." trailing={<Switch accessibilityLabel="Private channel" value={privateChannel} disabled={task.busy} onValueChange={setPrivate} />} />
    {task.error && <ErrorState message={task.error} />}
  </EditorSheet>;
}

function BrowseChannels({ onClose, onOpen }: { onClose: () => void; onOpen: (id: Id<'chats'>) => void }) {
  const channels = useQuery(api.chats.browse);
  const join = useMutation(api.chats.join);
  const task = useTask();
  return <Dialog title="Browse channels" onClose={onClose} busy={task.busy}>{task.error && <ErrorState message={task.error} />}{channels === undefined ? <Loading /> : !channels.length ? <EmptyState title="You're all caught up" description="You have joined every public channel." /> : channels.map((c) => <ListRow key={c._id} title={`#${c.name}`} description={c.topic ?? `${c.memberCount} members`} disabled={task.busy} trailing={<Text tone="link">Join</Text>} onPress={() => void task.run(async () => { await join({ chatId: c._id }); onClose(); onOpen(c._id); })} />)}</Dialog>;
}
