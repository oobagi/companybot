import { can } from '@companybot/core/permissions';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { NavigationHeader } from '@/components/navigation/NavigationHeader';
import { useTheme } from '@/design';
import { ActionMenu, ChoicePicker, EditorSheet, EmptyState, ErrorState, ListRow, Loading, Screen, ScreenList, Stack, Text, useConfirm } from '@/components/ui';

type PermissionAction = FunctionReturnType<typeof api.permissions.actions>[number];
function explanation(item: PermissionAction) {
  if (item.result === 'deny') return item.lock === 'block' ? 'Blocked by an owner.' : 'Agents cannot do this for you.';
  if (item.result === 'ask') return item.canAlways ? 'Asks first.' : 'Always asks because of a workspace rule.';
  if (item.risk === 'none') return 'Only reads. Runs without asking.';
  if (item.risk === 'inside') return 'Runs in your chats. Automations following other people’s words ask first.';
  return item.alwaysText;
}

export default function Permissions({ connectorId }: { connectorId?: string } = {}) {
  const { spacing, sizes } = useTheme();
  const actions = useQuery(api.permissions.actions, { connectorId });
  const rules = useQuery(api.permissions.mine);
  const me = useQuery(api.workspace.me);
  const set = useMutation(api.permissions.set);
  const lock = useMutation(api.permissions.setLock);
  const remove = useMutation(api.permissions.remove);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string>();
  const selected = actions?.find(action => action.action === editing);
  const grants = rules?.filter(rule => rule.automation) ?? [];
  if (!actions) return <Screen><Loading /></Screen>;
  return <>
    <NavigationHeader search={{ placeholder: 'Search actions', value: search, onChange: setSearch }} />
    <Screen nativeScroll padded={false}><ScreenList contentContainerStyle={{ paddingHorizontal: sizes.gutter }} data={actions.filter(action => `${action.label} ${action.service ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))} keyExtractor={action => action.action}
      ListHeaderComponent={<Stack style={{ paddingVertical: spacing.lg }}><Text variant="supporting" tone="muted">Agents ask before external actions. Workspace rules may require approval even when your preference allows an action.</Text>{task.error && !editing && <ErrorState message={task.error} />}</Stack>}
      ListEmptyComponent={<EmptyState title="No actions found" description="Try another name or service." />}
      renderItem={({ item }) => <ListRow title={item.label} description={[item.service, explanation(item)].filter(Boolean).join(' · ')} disclosure onPress={() => { task.clear(); setEditing(item.action); }} />}
      ListFooterComponent={grants.length ? <Stack><Text variant="label" tone="muted">Automation permissions</Text>{grants.map(rule => <ListRow key={rule._id} title={rule.automation!.name} description={rule.text} trailing={<ActionMenu label={`Permissions for ${rule.automation!.name}`} actions={[{ id: 'revoke', title: 'Revoke permission', icon: 'hand.raised', destructive: true, disabled: task.busy }]} onAction={id => { if (id === 'revoke' && !task.busy) void task.run(() => remove({ ruleId: rule._id })); }} />} />)}</Stack> : undefined}
    />
    </Screen>
    {editing && <EditorSheet title={selected?.label ?? 'Action unavailable'} busy={task.busy} onClose={() => setEditing(undefined)} size="content">
      {dialog}
      {selected ? <>
        {selected.service && <Text variant="supporting" tone="muted">{selected.service}</Text>}
        <Text>{explanation(selected)}</Text>
        <ChoicePicker label="For you" value={selected.setting} disabled={task.busy || selected.lock === 'block'} options={[
          { value: 'ask', label: selected.risk === 'none' || selected.risk === 'inside' ? 'Allowed' : 'Ask each time' },
          ...(selected.canAlways || selected.setting === 'always' ? [{ value: 'always', label: 'Always allow' }] : []),
          { value: 'never', label: 'Never allow' },
        ]} onChange={value => {
          if (task.busy || selected.lock === 'block') return;
          if (value === 'always' && selected.canAlways) void task.run(async () => {
            if (await confirm({ title: `Always allow ${selected.label}?`, body: selected.alwaysText, action: 'Always allow' })) await set({ action: selected.action, setting: 'always' });
          });
          else if (value === 'ask' || value === 'never') void task.run(() => set({ action: selected.action, setting: value }));
        }} />
        {me?.access && can(me.access, 'actions.lock') && <ChoicePicker label="Workspace rule" value={selected.lock ?? 'default'} disabled={task.busy} options={[
          { value: 'default', label: 'Default protection' }, { value: 'ask', label: 'Always ask' },
          { value: 'block', label: 'Block for everyone' }, { value: 'none', label: 'Let each person decide' },
        ]} onChange={value => {
          if (!task.busy && (value === 'default' || value === 'ask' || value === 'block' || value === 'none')) void task.run(() => lock({ action: selected.action, lock: value === 'default' ? null : value }));
        }} />}
        <Text variant="supporting" tone="muted">Changes save immediately.</Text>
        {task.error && <ErrorState message={task.error} />}
      </> : <EmptyState layout="inline" title="This action is no longer available" />}
    </EditorSheet>}
  </>;
}
