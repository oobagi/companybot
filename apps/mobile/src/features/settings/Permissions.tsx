import { useState } from 'react';
import { FlatList } from 'react-native';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { Button, Card, ChoicePicker, ConfirmSheet, EmptyState, ErrorState, Field, Loading, Screen, Stack, Text } from '@/components/ui';

export default function Permissions({ connectorId }: { connectorId?: string } = {}) {
  const actions = useQuery(api.permissions.actions, { connectorId });
  const rules = useQuery(api.permissions.mine);
  const me = useQuery(api.workspace.me);
  const set = useMutation(api.permissions.set);
  const lock = useMutation(api.permissions.setLock);
  const remove = useMutation(api.permissions.remove);
  const task = useTask();
  const [search, setSearch] = useState('');
  const [always, setAlways] = useState<{ action: string; label: string; text: string }>();
  if (!actions) return <Loading />;
  return <Screen><Stack style={{ flex: 1 }}><Text tone="muted">Agents ask before external actions. Workspace rules may require approval even when your preference allows an action.</Text><Field label="Search actions" value={search} onChangeText={setSearch} />{task.error && !always && <ErrorState message={task.error} />}
    <FlatList data={actions.filter(a => `${a.label} ${a.service ?? ''}`.toLowerCase().includes(search.toLowerCase()))} keyExtractor={a => a.action} contentContainerStyle={{ flexGrow: 1, gap: 12 }} ListEmptyComponent={<EmptyState title="No actions found" />} renderItem={({ item }) => <Card><Text variant="label">{item.label}</Text>{item.service && <Text tone="muted">{item.service}</Text>}<ChoicePicker label="For you" value={item.setting} disabled={task.busy || item.lock === 'block'} options={[{ value: 'ask', label: item.risk === 'none' || item.risk === 'inside' ? 'Allowed' : 'Ask each time' }, ...(item.canAlways || item.setting === 'always' ? [{ value: 'always', label: 'Always allow' }] : []), { value: 'never', label: 'Never allow' }]} onChange={v => { if (v === 'always') setAlways({ action: item.action, label: item.label, text: item.alwaysText }); else if (v === 'ask' || v === 'never') void task.run(() => set({ action: item.action, setting: v })); }} /><Text tone="muted">{item.result === 'deny' ? item.lock === 'block' ? 'Blocked by an owner.' : 'Agents cannot do this for you.' : item.result === 'ask' ? item.canAlways ? 'Asks first.' : 'Always asks because of a workspace rule.' : item.risk === 'none' ? 'Only reads. Runs without asking.' : item.risk === 'inside' ? 'Runs in your chats. Automations following other people’s words ask first.' : item.alwaysText}</Text>{me?.role === 'owner' && <ChoicePicker label="Workspace rule" value={item.lock ?? 'default'} disabled={task.busy} options={[{ value: 'default', label: 'Default protection' }, { value: 'ask', label: 'Always ask' }, { value: 'block', label: 'Block for everyone' }, { value: 'none', label: 'Let each person decide' }]} onChange={v => { if (v === 'default' || v === 'ask' || v === 'block' || v === 'none') void task.run(() => lock({ action: item.action, lock: v === 'default' ? null : v })); }} />}</Card>} ListFooterComponent={<Stack>{rules?.filter(r => r.automation).map(r => <Card key={r._id}><Text variant="label">{r.automation?.name}</Text><Text>{r.text}</Text><Button label="Revoke permission" variant="secondary" disabled={task.busy} onPress={() => void task.run(() => remove({ ruleId: r._id }))} /></Card>)}</Stack>} />
  </Stack>{always && <ConfirmSheet title={`Always allow ${always.label}?`} message={always.text} confirmLabel="Always allow" busy={task.busy} error={task.error} onClose={() => setAlways(undefined)} onConfirm={() => void task.run(async () => { await set({ action: always.action, setting: 'always' }); setAlways(undefined); })} />}</Screen>;
}
