import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { router } from 'expo-router';
import { useState } from 'react';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, ListRow, Loading, Screen, Section, Stack, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { Profile } from './Profile';
import { Dialog } from './Dialog';
import type { Chat } from './types';
import { chatTitle } from './types';
import { AccessSheet } from '@/features/access/AccessSheet';

export function ChatDetails({ chatId }: { chatId: Id<'chats'> }) {
  const chat = useQuery(api.chats.get, { chatId });
  if (chat === undefined) return <Loading />;
  if (!chat) return <EmptyState title="Chat not found" />;
  return <Details key={chatId} chat={chat} />;
}
function Details({ chat }: { chat: Chat }) {
  const team = useQuery(api.workspace.team);
  const chats = useQuery(api.chats.list);
  const update = useMutation(api.chats.updateChannel);
  const rename = useMutation(api.chats.renameChat);
  const add = useMutation(api.chats.addMembers);
  const remove = useMutation(api.chats.removeMember);
  const archive = useMutation(api.trash.move);
  const leave = useMutation(api.chats.leave);
  const close = useMutation(api.chats.closeDm);
  const setAccess = useMutation(api.chats.setAccess);
  const task = useTask();
  const [name, setName] = useState(chat.name ?? chat.label ?? '');
  const [topic, setTopic] = useState(chat.topic ?? '');
  const [mode, setMode] = useState(chat.replyMode);
  const [profile, setProfile] = useState<Chat['members'][number]>();
  const [adding, setAdding] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; text: string; run: () => Promise<unknown> }>();
  const navigateAway = () => router.dismissTo('/');
  const members = new Set(chat.members.map((m) => m.id));
  const candidates = [...(team?.members.filter((p) => !members.has(p.userId)).map((p) => ({ id: p.userId, name: p.name || p.email, image: p.image, agent: false })) ?? []), ...(chats?.agents.filter((a) => !members.has(a._id)).map((a) => ({ id: a._id, name: a.name, image: a.image, agent: true })) ?? [])];
  return <Screen scroll><Stack><Text variant="heading">{chatTitle(chat)}</Text>{chat.private && <Badge label="Private" />}{task.error && <ErrorState message={task.error} />}
    {chat.kind === 'channel' && <Button label="Who can access" variant="secondary" onPress={() => setAccessOpen(true)} />}
    {accessOpen && chat.access && <AccessSheet access={chat.access} editLabel="Post" requireEveryone={chat.isDefault} description={chat.private ? 'This private channel is also limited to its invited members.' : undefined} onSave={chat.canManage && !chat.trash ? entries => setAccess({ chatId: chat._id, access: entries ?? [] }) : undefined} onClose={() => setAccessOpen(false)} />}
    {(chat.canManage || chat.parentId) && !chat.trash && <Card><Field label="Name" value={name} onChangeText={setName} editable={!task.busy} />{chat.kind === 'channel' && <><Field label="Topic" value={topic} onChangeText={setTopic} multiline editable={!task.busy} /><Section title="When agents reply">{(['mentions', 'relevant'] as const).map((value) => <ListRow key={value} title={value === 'mentions' ? 'Only when mentioned' : 'When relevant'} selected={mode === value} trailing={mode === value ? <Text>Selected</Text> : undefined} onPress={() => setMode(value)} />)}</Section></>}<Button label="Save changes" loading={task.busy} disabled={!name.trim()} onPress={() => void task.run(() => chat.parentId ? rename({ chatId: chat._id, title: name.trim() }) : update({ chatId: chat._id, name: name.trim(), topic: topic.trim(), replyMode: mode }))} /></Card>}
    <Section title={`Members · ${chat.members.length}`} action={chat.kind === 'channel' && !chat.trash ? <Button label="Add" variant="ghost" onPress={() => setAdding(true)} /> : undefined}>
      {chat.members.map((member) => <ListRow key={member.id} title={member.name} onPress={() => setProfile(member)} leading={<Avatar name={member.name} image={member.image} agent={member.type === 'agent'} />} trailing={chat.canManage && !chat.trash && !(chat.isDefault && member.type === 'user') ? <Button label="Remove" accessibilityLabel={`Remove ${member.name}`} variant="ghost" onPress={() => setConfirm({ title: `Remove ${member.name}?`, text: 'They will lose access to this channel.', run: () => remove({ chatId: chat._id, ...(member.type === 'agent' ? { agentId: member.id as Id<'agents'> } : { userId: member.id as Id<'users'> }) }) })} /> : member.type === 'agent' ? <Badge label="Bot" /> : undefined} />)}
    </Section>
    {!chat.trash && chat.kind === 'channel' && !chat.isDefault && <Button label="Leave channel" variant="secondary" onPress={() => setConfirm({ title: 'Leave channel?', text: chat.private ? 'You will need another invitation to rejoin this private channel.' : 'You can join this public channel again.', run: async () => { await leave({ chatId: chat._id }); navigateAway(); } })} />}
    {!chat.trash && chat.kind === 'dm' && !chat.agentId && !chat.parentId && <Button label="Close conversation" variant="secondary" onPress={() => void task.run(async () => { await close({ chatId: chat._id }); navigateAway(); })} />}
    {!chat.trash && ((chat.canManage && !chat.isDefault) || !!chat.parentId) && <Button label="Archive conversation" variant="danger" onPress={() => setConfirm({ title: 'Archive conversation?', text: 'This conversation will leave the sidebar. Its messages are kept until an owner deletes them permanently.', run: async () => { await archive({ kind: 'channel', id: chat._id }); navigateAway(); } })} />}
    {profile && <Profile who={profile} onClose={() => setProfile(undefined)} />}
    {adding && <Dialog busy={task.busy} title="Add members" onClose={() => setAdding(false)}>{task.error && <ErrorState message={task.error} />}{candidates.map((p) => <ListRow key={p.id} title={p.name} leading={<Avatar name={p.name} image={p.image} agent={p.agent} />} disabled={task.busy} trailing={<Text tone="link">Add</Text>} onPress={() => void task.run(() => add({ chatId: chat._id, userIds: p.agent ? [] : [p.id as Id<'users'>], agentIds: p.agent ? [p.id as Id<'agents'>] : [] }))} />)}{!candidates.length && <EmptyState title="Everyone is here" />}</Dialog>}
    {confirm && <Dialog busy={task.busy} title={confirm.title} onClose={() => { if (!task.busy) setConfirm(undefined); }}><Text>{confirm.text}</Text>{task.error && <ErrorState message={task.error} />}<Button label="Confirm" variant="danger" loading={task.busy} onPress={() => void task.run(async () => { await confirm.run(); setConfirm(undefined); })} /></Dialog>}
  </Stack></Screen>;
}
