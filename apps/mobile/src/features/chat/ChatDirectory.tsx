import { ReorderSheet } from '@/features/arrangements/ReorderSheet';
import { useArrangements } from '@/features/arrangements/useArrangements';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { can } from '@companybot/core/permissions';
import { router } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';
import { ChannelIcon, PrivateChannelIcon } from '@/design/icons';
import { useTheme } from '@/design';
import { Avatar, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, SectionHeading, listContentStyle, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery, useWorkspace } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { DirectoryHeader } from '@/features/session/DirectoryHeader';
import { ActiveThreads } from './ActiveThreads';
import { Dialog } from './Dialog';
import { chatTitle } from './types';
import { ChatRowActions, type ChatRowTarget } from './ChatRowActions';
import { draftPrefix, useDraftedChats } from './drafts';

export function ChatDirectory() {
  const { colors, sizes, spacing } = useTheme();
  const chats = useQuery(api.chats.list);
  const arrangements = useArrangements();
  const me = useQuery(api.workspace.me);
  const openDm = useMutation(api.chats.openDm);
  const task = useTask();
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<'new' | 'channel' | 'browse' | 'threads' | 'organize'>();
  const [actions, setActions] = useState<ChatRowTarget>();
  const workspace = useWorkspace();
  const drafted = useDraftedChats(chats ? draftPrefix(chats.me, workspace?.id) : undefined);
  const open = (chatId: Id<'chats'>) => router.push({ pathname: '/chat/[chatId]', params: { chatId } });
  const matches = (name: string) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  if (chats === undefined || !arrangements.loaded) return <Screen><Loading label="Loading chats…" /></Screen>;
  if (!chats) return <Screen><EmptyState title="Workspace unavailable" /></Screen>;
  const channels = arrangements.order('channels', chats.channels).filter((c) => matches(chatTitle(c)));
  const agents = chats.agents.filter((a) => matches(a.name));
  const dms = chats.dms.filter((c) => (!c.agentId || c.parentId) && matches(chatTitle(c)));
  const dmPhoto = (c: (typeof chats.dms)[number]) => c.members.find(m => !(m.type === 'user' && m.id === chats.me))?.image ?? null;
  const rows: ({ key: string; heading: string } | { key: string; title: string; leading: React.ReactNode; unread?: boolean; mentioned?: boolean; draft?: boolean; target: ChatRowTarget; onPress: () => void })[] = [
    ...(channels.length ? [{ key: 'channels', heading: 'Channels' }] : []),
    ...channels.map(c => ({ key: c._id, title: c.label ?? c.name ?? chatTitle(c), leading: c.private ? <PrivateChannelIcon size={sizes.icon} color={colors.muted} /> : <ChannelIcon size={sizes.icon} color={colors.muted} />, unread: c.unread, mentioned: c.mentioned, draft: drafted(c._id), target: { kind: 'channel' as const, chatId: c._id, title: chatTitle(c), isDefault: c.isDefault, canManage: c.canManage }, onPress: () => open(c._id) })),
    ...(agents.length || dms.length ? [{ key: 'messages', heading: 'Direct messages' }] : []),
    ...agents.map(a => ({ key: a._id, title: a.name, leading: <Avatar name={a.name} image={a.image} agent />, unread: a.unread, mentioned: a.mentioned, draft: !!a.dmId && drafted(a.dmId), target: { kind: 'agent' as const, agentId: a._id, dmId: a.dmId, title: a.name }, onPress: () => { if (a.dmId) open(a.dmId); else void task.run(async () => open(await openDm({ userIds: [], agentIds: [a._id] }))); } })),
    ...dms.map(c => ({ key: c._id, title: chatTitle(c), leading: <Avatar name={chatTitle(c)} image={c.parentId ? undefined : dmPhoto(c)} agent={!!c.agentId} />, unread: c.unread, mentioned: c.mentioned, draft: drafted(c._id), target: { kind: c.parentId ? 'side' as const : 'dm' as const, chatId: c._id, title: chatTitle(c) }, onPress: () => open(c._id) })),
  ];
  return <><DirectoryHeader search={{ placeholder: 'Search chats', value: search, onChange: setSearch }} action={{ label: 'New message', onPress: () => setDialog('new') }} menu={[
    { label: 'Threads', icon: 'bubble.left.and.bubble.right', onPress: () => setDialog('threads') },
    ...(arrangements.writable ? [{ label: 'Organize channels', icon: 'arrow.up.arrow.down' as const, onPress: () => setDialog('organize') }] : []),
    { label: 'Browse channels', icon: 'number', onPress: () => setDialog('browse') },
    ...(me?.access && can(me.access, 'channels.edit') ? [{ label: 'New channel', icon: 'plus' as const, onPress: () => setDialog('channel') }] : []),
  ]} /><Screen keyboard nativeScroll padded={false} edges={['left', 'right']}>
    <ScreenList data={rows} keyExtractor={row => row.key} keyboardShouldPersistTaps="handled" contentContainerStyle={listContentStyle}
      ListHeaderComponent={task.error ? <ErrorState message={task.error} /> : undefined}
      ListEmptyComponent={<EmptyState title={search ? 'No chats found' : 'No conversations yet'} description={search ? 'Try a different name.' : 'Start a conversation with a teammate or agent.'} />}
      renderItem={({ item, index }) => 'heading' in item
        ? <View style={{ paddingTop: index === 0 ? 0 : spacing.xl, paddingBottom: spacing.sm }}><SectionHeading title={item.heading} /></View>
        : <ListRow title={item.title} leading={item.leading} description={item.draft ? 'Draft' : undefined} onLongPress={() => setActions(item.target)} accessibilityLabel={`${item.title}${item.mentioned ? ', mentioned you' : item.unread ? ', unread' : ''}${item.draft ? ', unsent draft' : ''}`} trailing={item.mentioned ? <Text variant="supporting" tone="link">@</Text> : item.unread ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.text }} /> : undefined} onPress={item.onPress} />} />
    {dialog === 'organize' && <ReorderSheet title="Organize channels" list="channels" items={chats.channels.map(channel => ({ _id: channel._id, title: chatTitle(channel) }))} onClose={() => setDialog(undefined)} />}
    {actions && <ChatRowActions target={actions} onClose={() => setActions(undefined)} />}
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
  const loading = chats === undefined || team === undefined;
  const matches = people.filter(person => person.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const recipients = people.filter(person => selected.includes(person.id));
  const start = () => void task.run(async () => {
    if (loading || !recipients.length) return;
    const id = await open({ userIds: recipients.filter(person => !person.agent).map(person => person.id as Id<'users'>), agentIds: recipients.filter(person => person.agent).map(person => person.id as Id<'agents'>) });
    onClose(); onOpen(id);
  });
  return <EditorSheet title="New message" onClose={onClose} busy={task.busy} scroll={false} submit={{ label: 'Start', disabled: loading || !recipients.length, onPress: start }}>
    <Field label="Find people or agents" value={query} onChangeText={setQuery} editable={!task.busy} autoCapitalize="none" />
    {task.error && <ErrorState message={task.error} />}
    {loading ? <Loading label="Loading people…" /> : <ScreenList data={matches} keyExtractor={person => person.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      ListEmptyComponent={<EmptyState title={people.length ? 'No matches' : 'No teammates available'} description={people.length ? 'Try another name.' : 'Invite a teammate or add an agent to start a conversation.'} />}
      renderItem={({ item: person }) => <ListRow title={person.name} leading={<Avatar name={person.name} image={person.image} agent={person.agent} />} selected={selected.includes(person.id)} disabled={task.busy}
        trailing={selected.includes(person.id) ? <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants">✓</Text> : undefined}
        onPress={() => setSelected(ids => ids.includes(person.id) ? ids.filter(id => id !== person.id) : [...ids, person.id])} />} />}
  </EditorSheet>;
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
