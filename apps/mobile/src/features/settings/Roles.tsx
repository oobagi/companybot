import { useState } from 'react';
import { can, permissions, switches } from '@companybot/core/permissions';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { Button, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Section, SettingsRow, Stack, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';

export type WorkspaceRole = NonNullable<FunctionReturnType<typeof api.roles.list>>[number];
export const roleNames = (ids: readonly string[], roles: readonly WorkspaceRole[]) => ids.map(id => roles.find(role => role.id === id)?.name ?? 'Removed role').join(', ') || 'No roles';

/** The native Switch owns the accessible label, rather than a second row target. */
export function RoleChoices({ roles, value, disabled = false, onChange }: { roles: WorkspaceRole[]; value: readonly Id<'roles'>[]; disabled?: boolean; onChange: (ids: Id<'roles'>[]) => void }) {
  return <Stack gap="none">{roles.map(role => <SettingsRow key={role.id} row={{ id: role.id, title: role.name, kind: 'toggle', value: value.includes(role.id), disabled, onValueChange: on => onChange(on ? [...value.filter(id => id !== role.id), role.id] : value.filter(id => id !== role.id)) }} />)}</Stack>;
}

type Mode = 'list' | 'detail' | 'create' | 'rename';

/** Browsing, permissions and deliberate name editing share one native presentation. */
export function Roles({ onClose }: { onClose: () => void }) {
  const roles = useQuery(api.roles.list);
  const me = useQuery(api.workspace.me);
  const [selected, setSelected] = useState<Id<'roles'>>();
  const [mode, setMode] = useState<Mode>('list');
  const [name, setName] = useState('');
  const [baseline, setBaseline] = useState('');
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const create = useMutation(api.roles.create); const rename = useMutation(api.roles.rename);
  const setPermission = useMutation(api.roles.setPermission); const remove = useMutation(api.roles.remove);
  const allowed = !!me?.access && can(me.access, 'roles.manage');
  const role = roles?.find(item => item.id === selected);
  const editing = mode === 'create' || mode === 'rename';
  const stale = mode === 'rename' && roles !== undefined && role?.name !== baseline;
  const dirty = editing && name !== baseline;
  const leaveEditor = () => { task.clear(); setName(''); setBaseline(''); setMode(mode === 'rename' ? 'detail' : 'list'); };
  const guard = useDraftGuard({ dirty, busy: task.busy, onClose: editing ? leaveEditor : onClose });
  const canSubmit = allowed && roles != null && !!name.trim() && (mode === 'create' ? roles.length < 30 : !!role && role.builtIn !== 'owner' && !stale && name.trim() !== baseline);
  const submit = () => {
    if (!canSubmit) return;
    void task.run(async () => {
      if (mode === 'create') setSelected(await create({ name: name.trim() }));
      else if (role) await rename({ id: role.id, name: name.trim() });
      setName(''); setBaseline(''); setMode('detail');
    });
  };
  const startName = (next: 'create' | 'rename') => {
    if (task.busy || !allowed || (next === 'rename' && (!role || role.builtIn === 'owner'))) return;
    const initial = next === 'rename' ? role!.name : '';
    task.clear(); setName(initial); setBaseline(initial); setMode(next);
  };
  const showRoles = () => { if (!task.busy) { task.clear(); setSelected(undefined); setMode('list'); } };
  return <EditorSheet title={mode === 'create' ? 'New role' : mode === 'rename' ? 'Rename role' : mode === 'detail' ? role?.name ?? 'Role' : 'Roles'}
    size={editing ? 'content' : 'large'} busy={task.busy} dismissible={!editing && guard.dismissible} onClose={() => void guard.close()}
    submit={editing ? { label: mode === 'create' ? 'Create' : 'Done', disabled: !canSubmit, onPress: submit } : undefined}>
    {guard.dialog}{dialog}{task.error && <ErrorState message={task.error} />}
    {editing ? <>
      {stale && <ErrorState message={role ? 'This role was renamed while you were editing. Reload its current name before saving.' : 'This role is no longer available.'} />}
      {stale && role && <Button label="Reload name" variant="secondary" disabled={task.busy} onPress={() => { setName(role.name); setBaseline(role.name); task.clear(); }} />}
      {!allowed && <Text tone="muted">You can no longer manage roles.</Text>}
      <Field label="Role name" value={name} onChangeText={setName} maxLength={40} autoFocus editable={allowed && !task.busy && !stale} />
      {mode === 'create' && <Text variant="supporting" tone="muted">New roles start without permissions. Choose their permissions after creating them.</Text>}
    </> : mode === 'list' ? <>
      <Text variant="supporting" tone="muted">People receive the combined permissions of all their roles. Owners always have full access.</Text>
      {allowed && <ListRow title="New role" disclosure disabled={task.busy || roles == null || roles.length >= 30} onPress={() => startName('create')} />}
      {roles === undefined ? <Loading /> : !roles?.length ? <EmptyState title="No roles available" /> : <Stack gap="none">{roles.map(item => <ListRow key={item.id} title={item.name} description={`${item.people} ${item.people === 1 ? 'person' : 'people'}`} disclosure disabled={task.busy} onPress={() => { task.clear(); setSelected(item.id); setMode('detail'); }} />)}</Stack>}
    </> : <>
      <Button label="All roles" variant="ghost" disabled={task.busy} onPress={showRoles} />
      {roles === undefined ? <Loading /> : !role ? <EmptyState title="Role unavailable" description="This role may have been deleted." /> : <>
        <Text variant="supporting" tone="muted">{role.people} {role.people === 1 ? 'person has' : 'people have'} this role.{role.invited ? ` It is also included in ${role.invited} pending ${role.invited === 1 ? 'invitation' : 'invitations'}.` : ''}</Text>
        {role.builtIn === 'owner' ? <Text>Owners can do everything. This role cannot be changed.</Text> : <>
          {allowed && <ListRow title="Rename role" disclosure disabled={task.busy} onPress={() => startName('rename')} />}
          <Section title="Permissions" description={allowed ? 'Changes take effect immediately.' : 'Only owners can change these permissions.'}>
            <Stack gap="none">{switches.map(permission => <SettingsRow key={permission} row={{ id: permission, title: permissions[permission].label, kind: 'toggle', value: role.permissions.includes(permission), disabled: !allowed || task.busy, onValueChange: on => { if (allowed && !task.busy) void task.run(() => setPermission({ id: role.id, permission, on })); } }} />)}</Stack>
          </Section>
          {allowed && role.builtIn !== 'member' && <Button label="Delete role" variant="danger" disabled={task.busy} onPress={() => void task.run(async () => {
            if (!await confirm({ title: `Delete ${role.name}?`, body: 'People lose the permissions this role grants. Their other roles remain. Access lists using this role will be updated.', action: 'Delete role', danger: true })) return;
            await remove({ id: role.id }); setSelected(undefined); setMode('list');
          })} />}
        </>}
      </>}
    </>}
  </EditorSheet>;
}
