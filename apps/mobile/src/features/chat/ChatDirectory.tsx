import { ReorderSheet } from '@/features/arrangements/ReorderSheet';
import { useArrangements } from '@/features/arrangements/useArrangements';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { can } from '@companybot/core/permissions';
import { router } from 'expo-router';
import { useState } from 'react';
import { Switch } from 'react-native';
import { Avatar, Badge, Button, EmptyState, ErrorState, Field, ListRow, Loading, Screen, Section, Stack, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { DirectoryHeader } from '@/features/session/DirectoryHeader';
import { ActiveThreads } from './ActiveThreads';
import { Dialog } from './Dialog';
import { chatTitle } from './types';

export function ChatDirectory() {
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
  return <><DirectoryHeader search={{ placeholder: 'Search chats', value: search, onChange: setSearch }} action={{ label: 'New message', onPress: () => setDialog('new') }} menu={[
    { label: 'Threads', onPress: () => setDialog('threads') },
    ...(arrangements.writable ? [{ label: 'Organize channels', onPress: () => setDialog('organize') }] : []),
    { label: 'Browse channels', onPress: () => setDialog('browse') },
    ...(me?.access && can(me.access, 'channels.edit') ? [{ label: 'New channel', onPress: () => setDialog('channel') }] : []),
  ]} /><Screen scroll edges={['left', 'right']}><Stack style={{ flexGrow: 1 }}>
    {task.error && <ErrorState message={task.error} />}
    {!agents.length && !channels.length && !dms.length ? <EmptyState title={search ? 'No chats found' : 'No conversations yet'} description={search ? 'Try a different name.' : 'Start a conversation with a teammate or agent.'} /> : <>
    {!!agents.length && <Section title="Agents">{agents.map((a) => <ListRow key={a._id} title={a.name} description={a.description} leading={<Avatar name={a.name} image={a.image} agent />} trailing={<Badge label={a.mentioned ? 'Mention' : a.unread ? 'Unread' : 'Agent'} />} onPress={() => { if (a.dmId) open(a.dmId); else void task.run(async () => open(await openDm({ userIds: [], agentIds: [a._id] }))); }} />)}</Section>}
    <Section title="Channels">
      {channels.map((c) => <ListRow key={c._id} title={chatTitle(c)} description={c.private ? 'Private channel' : c.topic ?? undefined} trailing={c.mentioned ? <Badge label="Mention" /> : c.unread ? <Badge label="Unread" /> : undefined} onPress={() => open(c._id)} />)}
      {!channels.length && <Text tone="muted">{search ? 'No matching channels.' : 'No channels yet.'}</Text>}
    </Section>
    <Section title="Direct messages">{dms.map((c) => <ListRow key={c._id} title={chatTitle(c)} description={c.parentId ? `Side chat · ${c.title}` : undefined} leading={<Avatar name={chatTitle(c)} agent={!!c.agentId} />} trailing={c.mentioned ? <Badge label="Mention" /> : c.unread ? <Badge label="Unread" /> : undefined} onPress={() => open(c._id)} />)}{!dms.length && <Text tone="muted">{search ? 'No matching messages.' : 'Start a conversation with your team.'}</Text>}</Section>
    </>}
    {dialog === 'organize' && <ReorderSheet title="Organize channels" list="channels" items={chats.channels.map(channel => ({ _id: channel._id, title: chatTitle(channel) }))} onClose={() => setDialog(undefined)} />}
    {dialog === 'threads' && <ActiveThreads onClose={() => setDialog(undefined)} />}
    {dialog === 'new' && <NewMessage onClose={() => setDialog(undefined)} onOpen={open} />}
    {dialog === 'channel' && <NewChannel onClose={() => setDialog(undefined)} onOpen={open} />}
    {dialog === 'browse' && <BrowseChannels onClose={() => setDialog(undefined)} onOpen={open} />}
  </Stack></Screen></>;
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
  return <Dialog title="New channel" onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy}>{guard.dialog}<Field label="Name" value={name} onChangeText={setName} editable={!task.busy} autoCapitalize="none" /><Field label="Topic" value={topic} onChangeText={setTopic} editable={!task.busy} multiline />
    <ListRow title="Private channel" description="Only invited members can read it." trailing={<Switch accessibilityLabel="Private channel" value={privateChannel} disabled={task.busy} onValueChange={setPrivate} />} />
    {task.error && <ErrorState message={task.error} />}<Button label="Create channel" loading={task.busy} disabled={!name.trim()} onPress={() => void task.run(async () => { const id = await create({ name: name.trim(), topic: topic.trim(), private: privateChannel }); onClose(); onOpen(id); })} />
  </Dialog>;
}

function BrowseChannels({ onClose, onOpen }: { onClose: () => void; onOpen: (id: Id<'chats'>) => void }) {
  const channels = useQuery(api.chats.browse);
  const join = useMutation(api.chats.join);
  const task = useTask();
  return <Dialog title="Browse channels" onClose={onClose} busy={task.busy}>{task.error && <ErrorState message={task.error} />}{channels === undefined ? <Loading /> : !channels.length ? <EmptyState title="You're all caught up" description="You have joined every public channel." /> : channels.map((c) => <ListRow key={c._id} title={`#${c.name}`} description={c.topic ?? `${c.memberCount} members`} disabled={task.busy} trailing={<Text tone="link">Join</Text>} onPress={() => void task.run(async () => { await join({ chatId: c._id }); onClose(); onOpen(c._id); })} />)}</Dialog>;
}
