import { useState } from 'react';
import { can } from '@companybot/core/permissions';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { ActionMenu, Avatar, Button, Card, EditorSheet, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Stack, Text, useConfirm } from '@/components/ui';
import { NavigationHeader } from '@/components/navigation/NavigationHeader';
import { RoleChoices, Roles, roleNames, type WorkspaceRole } from './Roles';

type Member = NonNullable<FunctionReturnType<typeof api.workspace.team>>['members'][number];
export default function Members() {
  const team = useQuery(api.workspace.team); const me = useQuery(api.workspace.me); const roles = useQuery(api.roles.list);
  const resend = useMutation(api.workspace.resendInvite); const cancel = useMutation(api.workspace.cancelInvite);
  const task = useTask();
  const [editing, setEditing] = useState<Id<'members'> | 'invite' | 'roles'>();
  const allowed = !!me?.access && can(me.access, 'members.manage');
  if (!team || !roles) return <Screen><Loading /></Screen>;
  if (!roles.length) return <Screen><Loading label="Workspace roles are being set up…" /></Screen>;
  const ownerId = roles.find(role => role.builtIn === 'owner')?.id;
  const canEditMember = (member: Member) => allowed && (!!me?.access?.owner || !member.roles.some(id => id === ownerId));
  const selected = team.members.find(member => member.id === editing);
  return <>
    <NavigationHeader action={allowed ? { label: 'Invite a teammate', onPress: () => setEditing('invite'), disabled: task.busy } : undefined} menu={[{ label: 'Roles and permissions', onPress: () => setEditing('roles') }]} />
    <Screen nativeScroll padded={false}><ScreenList data={team.members} keyExtractor={member => member.id}
    ListHeaderComponent={task.error ? <ErrorState message={task.error} /> : undefined}
    renderItem={({ item }) => <ListRow title={`${item.name}${item.isYou ? ' (you)' : ''}`} description={`${item.email} · ${roleNames(item.roles, roles)}`} leading={<Avatar name={item.name} image={item.image} />} onPress={canEditMember(item) ? () => setEditing(item.id) : undefined} />}
    ListFooterComponent={team.invites.length ? <Stack><Text variant="label" tone="muted">Pending invitations</Text>{team.invites.map(invite => <ListRow key={invite.id} title={invite.email} description={`Invited as ${roleNames(invite.roles, roles)}`} trailing={allowed ? <ActionMenu label={`Invitation actions for ${invite.email}`} actions={[
      { id: 'resend', title: 'Resend invitation', icon: 'envelope', disabled: task.busy },
      { id: 'cancel', title: 'Cancel invitation', icon: 'trash', destructive: true, disabled: task.busy },
    ]} onAction={action => { if (task.busy) return; if (action === 'resend') void task.run(() => resend({ id: invite.id })); else if (action === 'cancel') void task.run(() => cancel({ id: invite.id })); }} /> : undefined} />)}</Stack> : undefined} />
    </Screen>
    {editing === 'roles' ? <Roles onClose={() => setEditing(undefined)} /> : editing === 'invite' || selected ? <MemberEditor key={editing} member={selected} roles={roles} allowed={selected ? canEditMember(selected) : allowed} owner={!!me?.access?.owner} onClose={() => setEditing(undefined)} /> : null}
  </>;
}
function MemberEditor({ member, roles, allowed, owner, onClose }: { member?: Member; roles: WorkspaceRole[]; allowed: boolean; owner: boolean; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [initial, setInitial] = useState(() => member?.roles ?? roles.filter(role => role.builtIn === 'member').map(role => role.id));
  const [picked, setPicked] = useState(initial);
  const task = useTask(); const { confirm, dialog } = useConfirm();
  const invite = useMutation(api.workspace.invite); const setRoles = useMutation(api.workspace.setRoles); const remove = useMutation(api.workspace.removeMember);
  const dirty = email !== '' || picked.length !== initial.length || picked.some(id => !initial.includes(id));
  const stale = !!member && (member.roles.length !== initial.length || member.roles.some(id => !initial.includes(id)));
  const guard = useDraftGuard({ dirty, busy: task.busy, onClose });
  const valid = picked.length > 0 && picked.every(id => roles.some(role => role.id === id && (owner || role.builtIn !== 'owner')));
  return <EditorSheet title={member?.name ?? 'Invite a teammate'} busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>
    {guard.dialog}{dialog}
    {member ? <Text>{member.email}</Text> : <Field label="Email address" value={email} onChangeText={setEmail} editable={allowed && !task.busy} keyboardType="email-address" autoCapitalize="none" autoFocus />}
    {stale && <Card><Text>This person’s roles changed while you were editing. Reload before saving.</Text><Button label="Reload roles" variant="secondary" disabled={task.busy} onPress={() => { setInitial(member.roles); setPicked(member.roles); task.clear(); }} /></Card>}
    <Text variant="label">Roles</Text>
    <RoleChoices value={picked} disabled={!allowed || task.busy || stale} roles={roles.filter(role => owner || role.builtIn !== 'owner')} onChange={setPicked} />
    <Text tone="muted">Choose at least one role. Their permissions are combined.</Text>
    {task.error && <ErrorState message={task.error} />}
    <Button label={member ? 'Save roles' : 'Send invitation'} loading={task.busy} disabled={!allowed || !valid || stale || (member ? !dirty : !/^\S+@\S+\.\S+$/.test(email.trim()))} onPress={() => void task.run(async () => {
      if (member) await setRoles({ id: member.id, roles: picked, expectedRoles: initial }); else await invite({ email: email.trim(), roles: picked });
      onClose();
    })} />
    {member && !member.isYou && allowed && <Button label="Remove from workspace" variant="danger" disabled={task.busy} onPress={() => void task.run(async () => {
      if (!await confirm({ title: `Remove ${member.name}?`, body: 'Their access ends immediately. Their messages stay in team history.', action: 'Remove member', danger: true })) return;
      await remove({ id: member.id }); onClose();
    })} />}
  </EditorSheet>;
}
