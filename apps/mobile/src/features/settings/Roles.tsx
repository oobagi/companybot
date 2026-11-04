import { useState } from 'react';
import { Switch } from 'react-native';
import { can, permissions, switches } from '@companybot/core/permissions';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { Button, EditorSheet, ErrorState, Field, ListRow, Loading, Stack, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';

export type WorkspaceRole = NonNullable<FunctionReturnType<typeof api.roles.list>>[number];
export const roleNames = (ids: readonly string[], roles: readonly WorkspaceRole[]) => ids.map(id => roles.find(role => role.id === id)?.name ?? 'Removed role').join(', ') || 'No roles';

/** Inline selection keeps role editing within its existing native sheet. */
export function RoleChoices({ roles, value, disabled = false, onChange }: { roles: WorkspaceRole[]; value: readonly Id<'roles'>[]; disabled?: boolean; onChange: (ids: Id<'roles'>[]) => void }) {
  return <Stack gap="none">{roles.map(role => <ListRow key={role.id} title={role.name} trailing={<Switch accessibilityLabel={role.name} value={value.includes(role.id)} disabled={disabled} onValueChange={on => onChange(on ? [...value.filter(id => id !== role.id), role.id] : value.filter(id => id !== role.id))} />} />)}</Stack>;
}

/** One native sheet: list, deliberate creation, then the selected role's permissions. */
export function Roles({ onClose }: { onClose: () => void }) {
  const roles = useQuery(api.roles.list);
  const me = useQuery(api.workspace.me);
  const [selected, setSelected] = useState<Id<'roles'> | 'new'>();
  const [name, setName] = useState('');
  const [baseline, setBaseline] = useState('');
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const create = useMutation(api.roles.create); const rename = useMutation(api.roles.rename);
  const setPermission = useMutation(api.roles.setPermission); const remove = useMutation(api.roles.remove);
  const allowed = !!me?.access && can(me.access, 'roles.manage');
  const role = roles?.find(item => item.id === selected);
  const dirty = name !== baseline;
  const guard = useDraftGuard({ dirty, busy: task.busy, onClose });
  const back = async () => {
    if (task.busy || (dirty && !await confirm({ title: 'Discard role name?', body: 'Your unsaved name will be discarded. Permission changes already took effect.', action: 'Discard', danger: true }))) return;
    task.clear(); setSelected(undefined); setName(''); setBaseline('');
  };
  return <EditorSheet title={selected === 'new' ? 'New role' : role?.name ?? 'Roles'} busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>
    {guard.dialog}{dialog}{task.error && <ErrorState message={task.error} />}
    {selected === undefined ? <>
      <Text tone="muted">People receive the combined permissions of all their roles. Owners always have full access.</Text>
      {allowed && <Button label="New role" disabled={task.busy || (roles?.length ?? 0) >= 30} onPress={() => { setSelected('new'); setName(''); setBaseline(''); }} />}
      {!roles ? <Loading /> : roles.map(item => <ListRow key={item.id} title={item.name} description={`${item.people} ${item.people === 1 ? 'person' : 'people'}`} onPress={() => { task.clear(); setSelected(item.id); setName(item.name); setBaseline(item.name); }} />)}
    </> : <>
      <Button label="Back to roles" variant="ghost" disabled={task.busy} onPress={() => void back()} />
      {selected === 'new' ? <>
        <Field label="Role name" value={name} onChangeText={setName} maxLength={40} autoFocus editable={allowed && !task.busy} />
        <Text tone="muted">New roles start without permissions. Choose their permissions after creating them.</Text>
        <Button label="Create role" loading={task.busy} disabled={!allowed || !name.trim()} onPress={() => void task.run(async () => { const id = await create({ name: name.trim() }); setSelected(id); setBaseline(name.trim()); setName(name.trim()); })} />
      </> : !roles ? <Loading /> : !role ? <Text>This role is no longer available.</Text> : <>
        {role.builtIn === 'owner' ? <Text>Owners can do everything. This role cannot be changed.</Text> : <>
          <Field label="Role name" value={name} onChangeText={setName} maxLength={40} editable={allowed && !task.busy} />
          {dirty && <Button label="Save name" loading={task.busy} disabled={!allowed || !name.trim()} onPress={() => void task.run(async () => { await rename({ id: role.id, name: name.trim() }); setBaseline(name.trim()); setName(name.trim()); })} />}
          <Text tone="muted">Permission changes take effect immediately.</Text>
          <Stack gap="none">{switches.map(permission => <ListRow key={permission} title={permissions[permission].label} trailing={<Switch accessibilityLabel={permissions[permission].label} value={role.permissions.includes(permission)} disabled={!allowed || task.busy} onValueChange={on => void task.run(() => setPermission({ id: role.id, permission, on }))} />} />)}</Stack>
          {allowed && role.builtIn !== 'member' && <Button label="Delete role" variant="danger" disabled={task.busy} onPress={() => void task.run(async () => {
            if (!await confirm({ title: `Delete ${role.name}?`, body: 'People lose the permissions this role grants. Their other roles remain. Access lists using this role will be updated.', action: 'Delete role', danger: true })) return;
            await remove({ id: role.id }); setSelected(undefined); setName(''); setBaseline('');
          })} />}
        </>}
      </>}
    </>}
  </EditorSheet>;
}
