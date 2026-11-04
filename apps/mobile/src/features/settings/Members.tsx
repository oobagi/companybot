import { useState } from 'react';
import { FlatList } from 'react-native';
import { can, type Role } from '@companybot/core/permissions';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { Avatar, Button, Card, ChoicePicker, ConfirmSheet, EditorSheet, ErrorState, Field, ListRow, Loading, Screen, Stack, Text } from '@/components/ui';

type Member = NonNullable<FunctionReturnType<typeof api.workspace.team>>['members'][number];
const roles = [{ value: 'owner', label: 'Owner' }, { value: 'member', label: 'Member' }];
export default function Members() {
  const team = useQuery(api.workspace.team);
  const me = useQuery(api.workspace.me);
  const invite = useMutation(api.workspace.invite);
  const resend = useMutation(api.workspace.resendInvite);
  const cancel = useMutation(api.workspace.cancelInvite);
  const remove = useMutation(api.workspace.removeMember);
  const setRole = useMutation(api.workspace.setRole);
  const task = useTask();
  const [email, setEmail] = useState('');
  const [role, setRoleValue] = useState<Role>('member');
  const [editing, setEditing] = useState<Member>();
  const [removing, setRemoving] = useState<Member>();
  const [inviting, setInviting] = useState(false);
  const allowed = !!me?.role && can(me.role, 'members.manage');
  if (!team) return <Loading />;
  return <Screen><FlatList data={team.members} keyExtractor={m => m.id} ListHeaderComponent={<Stack>{allowed && <Button label="Invite a teammate" onPress={() => setInviting(true)} />}{task.error && !editing && !inviting && !removing && <ErrorState message={task.error} />}</Stack>} renderItem={({ item }) => <ListRow title={`${item.name}${item.isYou ? ' (you)' : ''}`} description={`${item.email} · ${item.role}`} leading={<Avatar name={item.name} image={item.image} />} onPress={allowed ? () => { task.clear(); setEditing(item); } : undefined} />} ListFooterComponent={<Stack>{team.invites.map(i => <Card key={i.id}><Text variant="label">{i.email}</Text><Text tone="muted">Invited as {i.role}</Text><Button label="Resend invitation" variant="secondary" disabled={task.busy} onPress={() => void task.run(() => resend({ id: i.id }))} /><Button label="Cancel invitation" variant="ghost" disabled={task.busy} onPress={() => void task.run(() => cancel({ id: i.id }))} /></Card>)}</Stack>} />
  {inviting && <EditorSheet title="Invite a teammate" onClose={() => setInviting(false)} busy={task.busy}><Field label="Email address" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" /><ChoicePicker label="Role" value={role} options={roles} onChange={v => { if (v === 'owner' || v === 'member') setRoleValue(v); }} />{task.error && <ErrorState message={task.error} />}<Button label="Send invitation" disabled={!email.trim()} loading={task.busy} onPress={() => void task.run(async () => { if (!email.trim()) return; await invite({ email: email.trim(), role }); setEmail(''); setInviting(false); })} /></EditorSheet>}
  {editing && <EditorSheet title={editing.name} onClose={() => setEditing(undefined)} busy={task.busy}><Text>{editing.email}</Text><ChoicePicker label="Role" value={editing.role} options={roles} onChange={v => { if (v === 'owner' || v === 'member') setEditing({ ...editing, role: v }); }} />{task.error && <ErrorState message={task.error} />}<Button label="Save role" loading={task.busy} onPress={() => void task.run(async () => { await setRole({ id: editing.id, role: editing.role }); setEditing(undefined); })} />{!editing.isYou && <Button label="Remove from workspace" variant="danger" onPress={() => { setRemoving(editing); setEditing(undefined); }} />}</EditorSheet>}
  {removing && <ConfirmSheet title={`Remove ${removing.name}?`} message="Their access ends immediately. Their messages stay in team history." confirmLabel="Remove member" destructive busy={task.busy} error={task.error} onClose={() => setRemoving(undefined)} onConfirm={() => void task.run(async () => { await remove({ id: removing.id }); setRemoving(undefined); })} />}
  </Screen>;
}
