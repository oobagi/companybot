import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { router, Stack as RouterStack } from 'expo-router';
import { useState } from 'react';
import AddPerson from '@expo/material-symbols/person_add.xml';
import RemovePerson from '@expo/material-symbols/person_remove.xml';
import Leave from '@expo/material-symbols/logout.xml';
import Close from '@expo/material-symbols/close.xml';
import { TOPIC_MAX } from '@companybot/core/chat';
import { Avatar, Button, ChoicePicker, ConfirmSheet, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import type { Action } from '@/components/ui/ActionMenu';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { Profile } from './Profile';
import type { Chat } from './types';
import { chatTitle } from './types';
import { AccessSheet } from '@/features/access/AccessSheet';

export function ChatDetails({ chatId }: { chatId: Id<'chats'> }) {
  const chat = useQuery(api.chats.get, { chatId });
  if (chat === undefined) return <Screen><Loading /></Screen>;
  if (!chat) return <Screen><EmptyState title="Chat not found" /></Screen>;
  return <Details key={chatId} chat={chat} />;
}
function Details({ chat }: { chat: Chat }) {
  const { spacing } = useTheme();
  const team = useQuery(api.workspace.team);
  const chats = useQuery(api.chats.list);
  const add = useMutation(api.chats.addMembers);
  const remove = useMutation(api.chats.removeMember);
  const archive = useMutation(api.trash.move);
  const leave = useMutation(api.chats.leave);
  const close = useMutation(api.chats.closeDm);
  const setAccess = useMutation(api.chats.setAccess);
  const task = useTask();
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState<Chat['members'][number]>();
  const [adding, setAdding] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: string; run: () => Promise<unknown> }>();
  const guard = useDraftGuard({ dirty: false, busy: task.busy, onClose: () => {} });
  const navigateAway = () => router.dismissTo('/');
  const members = new Set(chat.members.map(m => m.id));
  const candidates = [...(team?.members.filter(p => !members.has(p.userId)).map(p => ({ id: p.userId, name: p.name || p.email, image: p.image, agent: false })) ?? []), ...(chats?.agents.filter(a => !members.has(a._id)).map(a => ({ id: a._id, name: a.name, image: a.image, agent: true })) ?? [])];
  const canEdit = !!(chat.canManage || chat.parentId) && !chat.trash;
  const removable = chat.kind === 'channel' && chat.canManage && !chat.trash && chats ? chat.members.filter(member => member.id !== chats?.me && !(chat.isDefault && member.type === 'user')) : [];
  const actions: Action[] = [
    ...(canEdit ? [{ id: 'edit', title: 'Edit conversation', icon: 'pencil' as const }] : []),
    ...(chat.kind === 'channel' && !chat.trash ? [{ id: 'add', title: 'Add members', icon: process.env.EXPO_OS === 'ios' ? 'person.badge.plus' as const : AddPerson }] : []),
    ...(removable.length ? [{ id: 'remove', title: 'Remove member', icon: process.env.EXPO_OS === 'ios' ? 'person.badge.minus' as const : RemovePerson, items: removable.map(member => ({ id: `remove:${member.id}`, title: member.name, destructive: true })) }] : []),
    ...(!chat.trash && chat.kind === 'channel' && !chat.isDefault ? [{ id: 'leave', title: 'Leave channel', destructive: true, icon: process.env.EXPO_OS === 'ios' ? 'rectangle.portrait.and.arrow.right' as const : Leave }] : []),
    ...(!chat.trash && chat.kind === 'dm' && !chat.agentId && !chat.parentId ? [{ id: 'close', title: 'Close conversation', icon: process.env.EXPO_OS === 'ios' ? 'xmark' as const : Close }] : []),
    ...(!chat.trash && ((chat.canManage && !chat.isDefault) || !!chat.parentId) ? [{ id: 'archive', title: 'Archive conversation', destructive: true, icon: 'archivebox' as const }] : []),
  ];
  const identity = chat.agentId ? chat.members.find(member => member.id === chat.agentId)
    : chat.kind === 'dm' && chat.members.length === 2 && chats ? chat.members.find(member => member.id !== chats.me) : undefined;
  const details = <Stack style={{ padding: spacing.md }}>
    <Stack horizontal gap="md">
      <Avatar name={chatTitle(chat)} image={identity?.image} agent={!!chat.agentId} size="lg" />
      <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>{chatTitle(chat)}</Text>
    </Stack>
    {chat.topic && <Text selectable>{chat.topic}</Text>}
    {chat.trash && <Text variant="supporting" tone="muted">Archived · Messages are kept.</Text>}
    {chat.kind === 'channel' && <Stack gap="sm">
      <Text variant="supporting" tone="muted">{chat.private ? 'Private channel · Invited members only.' : 'Channel access follows workspace roles.'} {chat.replyMode === 'mentions' ? 'Agents reply when mentioned.' : 'Agents reply when relevant.'}</Text>
      {chat.access && <Button label="Access" variant="ghost" disabled={task.busy} onPress={() => setAccessOpen(true)} style={{ alignSelf: 'flex-start' }} />}
    </Stack>}
    {task.error && !adding && !confirm && <ErrorState message={task.error} />}
    <Text variant="label" accessibilityRole="header">Members · {chat.members.length}</Text>
  </Stack>;
  return <>
    <RouterStack.Screen options={{ title: 'Details' }} />
    {actions.length > 0 && <HeaderMenu label="Conversation details actions" actions={actions.map(action => ({ ...action, disabled: task.busy || editing || adding || accessOpen || !!profile || !!confirm }))} onAction={id => {
      if (task.busy || editing || adding || accessOpen || profile || confirm) return;
      task.clear();
      if (id === 'edit') setEditing(true);
      else if (id === 'add') setAdding(true);
      else if (id.startsWith('remove:')) {
        const member = removable.find(member => member.id === id.slice(7));
        if (member) setConfirm({ title: `Remove ${member.name}?`, text: 'They will lose access to this channel.', action: 'Remove member', run: () => remove({ chatId: chat._id, ...(member.type === 'agent' ? { agentId: member.id as Id<'agents'> } : { userId: member.id as Id<'users'> }) }) });
      } else if (id === 'leave') setConfirm({ title: 'Leave channel?', text: chat.private ? 'You will need another invitation to rejoin this private channel.' : 'You can join this public channel again.', action: 'Leave channel', run: async () => { await leave({ chatId: chat._id }); guard.complete(); navigateAway(); } });
      else if (id === 'close') void task.run(async () => { await close({ chatId: chat._id }); guard.complete(); navigateAway(); });
      else if (id === 'archive') setConfirm({ title: 'Archive conversation?', text: 'This conversation leaves your list. Its messages are kept until an owner deletes them permanently.', action: 'Archive', run: async () => { await archive({ kind: 'channel', id: chat._id }); guard.complete(); navigateAway(); } });
    }} />}
    <Screen nativeScroll padded={false}>
      {guard.dialog}
      <ScreenList data={chat.members} keyExtractor={member => member.id} ListHeaderComponent={details}
        contentContainerStyle={{ paddingHorizontal: spacing.xs, paddingBottom: spacing.lg }}
        renderItem={({ item: member }) => <ListRow title={member.name} description={member.type === 'agent' ? 'Bot' : undefined} leading={<Avatar name={member.name} image={member.image} agent={member.type === 'agent'} />} disclosure onPress={() => setProfile(member)} disabled={task.busy} />}
        ListEmptyComponent={<EmptyState layout="inline" title="No members" />} />
    </Screen>
    {editing && <ConversationEditor chat={chat} onClose={() => setEditing(false)} />}
    {accessOpen && chat.access && <AccessSheet access={chat.access} editLabel="Post" requireEveryone={chat.isDefault} description={chat.private ? 'This private channel is also limited to its invited members.' : undefined} onSave={chat.canManage && !chat.trash ? entries => setAccess({ chatId: chat._id, access: entries ?? [] }) : undefined} onClose={() => setAccessOpen(false)} />}
    {profile && <Profile who={profile} onClose={() => setProfile(undefined)} />}
    {adding && <EditorSheet busy={task.busy} title="Add members" onClose={() => setAdding(false)}>
      {task.error && <ErrorState message={task.error} />}
      {!team || !chats ? <Loading /> : candidates.map(person => <ListRow key={person.id} title={person.name} leading={<Avatar name={person.name} image={person.image} agent={person.agent} />} disabled={task.busy || !!chat.trash} onPress={() => void task.run(() => add({ chatId: chat._id, userIds: person.agent ? [] : [person.id as Id<'users'>], agentIds: person.agent ? [person.id as Id<'agents'>] : [] }))} />)}
      {team && chats && !candidates.length && <EmptyState title="Everyone is here" />}
    </EditorSheet>}
    {confirm && <ConfirmSheet busy={task.busy} title={confirm.title} message={confirm.text} confirmLabel={confirm.action} destructive error={task.error} onClose={() => setConfirm(undefined)} onConfirm={() => void task.run(async () => { await confirm.run(); setConfirm(undefined); })} />}
  </>;
}

function ConversationEditor({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const [baseline] = useState(() => ({ name: chat.name ?? chat.label ?? '', topic: chat.topic ?? '', mode: chat.replyMode }));
  const [name, setName] = useState(baseline.name);
  const [topic, setTopic] = useState(baseline.topic);
  const [mode, setMode] = useState(baseline.mode);
  const update = useMutation(api.chats.updateChannel);
  const rename = useMutation(api.chats.renameChat);
  const task = useTask();
  const dirty = name !== baseline.name || topic !== baseline.topic || mode !== baseline.mode;
  const guard = useDraftGuard({ dirty, busy: task.busy, onClose });
  const allowed = !!(chat.canManage || chat.parentId) && !chat.trash;
  const stale = (chat.name ?? chat.label ?? '') !== baseline.name || (chat.topic ?? '') !== baseline.topic || chat.replyMode !== baseline.mode;
  const canSave = allowed && !stale && dirty && !!name.trim();
  const save = () => {
    if (!canSave) return;
    void task.run(async () => {
      if (chat.parentId) await rename({ chatId: chat._id, title: name.trim() });
      else await update({ chatId: chat._id, name: name.trim(), topic: topic.trim(), replyMode: mode });
      guard.complete(); onClose();
    });
  };
  return <EditorSheet title="Edit conversation" size="content" busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()} submit={{ onPress: save, disabled: !canSave }}>
    {guard.dialog}
    {task.error && <ErrorState message={task.error} />}
    {!allowed && <ErrorState message="This conversation can no longer be edited." />}
    {stale && <ErrorState message="This conversation changed while you were editing. Close and reopen the editor to load its latest details." />}
    <Field label="Name" maxLength={chat.parentId ? 120 : 80} value={name} onChangeText={setName} editable={allowed && !task.busy} autoFocus />
    {chat.kind === 'channel' && <>
      <Field label="Topic" maxLength={TOPIC_MAX} value={topic} onChangeText={setTopic} multiline editable={allowed && !task.busy} />
      <ChoicePicker label="Agents reply" value={mode} options={[{ value: 'mentions', label: 'Only when mentioned' }, { value: 'relevant', label: 'When relevant' }]} disabled={!allowed || task.busy} onChange={value => { if (value === 'mentions' || value === 'relevant') setMode(value); }} />
    </>}
  </EditorSheet>;
}
