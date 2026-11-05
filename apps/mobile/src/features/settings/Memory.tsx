import { can } from '@companybot/core/permissions';
import { useState } from 'react';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { ActionMenu, Button, Card, ChoicePicker, ConfirmSheet, Divider, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Text } from '@/components/ui';
import { NavigationHeader } from '@/components/navigation/NavigationHeader';

type MemoryRow = FunctionReturnType<typeof api.memory.list>[number];
export default function Memory() {
  const memories = useQuery(api.memory.list);
  const me = useQuery(api.workspace.me);
  const teamAllowed = !!me?.access && can(me.access, 'memory.team.write');
  const agents = useQuery(api.agents.list);
  const create = useMutation(api.memory.create);
  const update = useMutation(api.memory.update);
  const remove = useMutation(api.memory.remove);
  const task = useTask();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<MemoryRow | 'new'>();
  const [deleting, setDeleting] = useState<MemoryRow>();
  const [history, setHistory] = useState<MemoryRow>();
  const [content, setContent] = useState('');
  const [agentId, setAgentId] = useState('');
  const [scope, setScope] = useState<'workspace' | 'personal'>('personal');
  const [baseline, setBaseline] = useState('');
  const draft = JSON.stringify(editing === 'new' ? { content, agentId, scope } : { content });
  const guard = useDraftGuard({ dirty: !!editing && draft !== baseline, busy: !!editing && task.busy, onClose: () => setEditing(undefined) });
  if (!memories || !agents) return <Screen><Loading label="Loading memories…" /></Screen>;
  const unavailable = task.busy || !!editing || !!deleting || !!history;
  const startNew = () => {
    if (unavailable || !agents.length) return;
    task.clear(); setEditing('new'); setContent(''); setAgentId(agents[0]._id); setScope('personal');
    setBaseline(JSON.stringify({ content: '', agentId: agents[0]._id, scope: 'personal' }));
  };
  const perform = (id: MemoryRow['id'], action: string) => {
    // Native menus may remain visible while the subscription removes a memory
    // or revokes editing. Resolve the current row when an action is selected.
    const item = memories.find(memory => memory.id === id);
    if (unavailable || !item?.canEdit) return;
    task.clear();
    if (action === 'edit') {
      setContent(item.content); setBaseline(JSON.stringify({ content: item.content })); setEditing(item);
    } else if (action === 'history') setHistory(item);
    else if (action === 'remove') setDeleting(item);
  };
  const query = search.trim().toLocaleLowerCase();
  const filtered = memories.filter(memory => memory.content.toLocaleLowerCase().includes(query));
  return <>
    <NavigationHeader search={{ placeholder: 'Search memories', value: search, onChange: setSearch }} action={{ label: 'New memory', onPress: startNew, disabled: unavailable || !agents.length }} />
    <Screen nativeScroll padded={false}>
      <ScreenList data={filtered} keyExtractor={memory => memory.id} ItemSeparatorComponent={Divider}
        ListEmptyComponent={<EmptyState title={query ? 'No matching memories' : 'No memories yet'} description={query ? 'Try another search or clear your filter.' : agents.length ? 'Agents remember useful context here. Personal memories are visible only to you.' : 'Create an agent before adding memories.'} action={query ? <Button label="Clear search" variant="secondary" onPress={() => setSearch('')} /> : undefined} />}
        renderItem={({ item }) => <ListRow title={item.content} selectable description={`${agents.find(agent => agent._id === item.agentId)?.name ?? 'Agent'} · ${item.scope === 'personal' ? 'Personal' : 'Team'} · Updated by ${item.updatedByName}`}
          trailing={item.canEdit ? <ActionMenu label="Memory actions" actions={[
            { id: 'edit', title: 'Edit', icon: 'pencil', disabled: unavailable },
            { id: 'history', title: 'History', icon: 'clock.arrow.circlepath', disabled: unavailable },
            { id: 'remove', title: item.scope === 'personal' ? 'Delete' : 'Archive', icon: item.scope === 'personal' ? 'trash' : 'archivebox', destructive: true, disabled: unavailable },
          ]} onAction={action => perform(item.id, action)} /> : undefined} />} />
    </Screen>
  {editing && <EditorSheet title={editing === 'new' ? 'New memory' : 'Edit memory'} busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>{guard.dialog}{editing === 'new' && <><ChoicePicker label="Agent" value={agentId} options={agents.map(a => ({ value: a._id, label: a.name }))} disabled={task.busy} onChange={v => { if (typeof v === 'string') setAgentId(v); }} /><ChoicePicker label="Who can see this?" value={scope} options={[{ value: 'personal', label: 'Only you' }, ...(teamAllowed ? [{ value: 'workspace', label: 'Everyone in the workspace' }] : [])]} disabled={task.busy} onChange={v => { if (v === 'workspace' || v === 'personal') setScope(v); }} /></>}<Field label="Memory" value={content} onChangeText={setContent} editable={!task.busy} multiline style={{ minHeight: 180 }} />{task.error && <ErrorState message={task.error} />}<Button label="Save memory" loading={task.busy} disabled={!content.trim() || (editing === 'new' && (!agentId || (scope === 'workspace' && !teamAllowed)))} onPress={() => void task.run(async () => { if (editing === 'new') await create({ agentId: agentId as Id<'agents'>, scope, content }); else await update({ id: editing.id, content, expectedVersion: editing.version }); setEditing(undefined); })} /></EditorSheet>}
  {deleting && <ConfirmSheet title={deleting.scope === 'personal' ? 'Delete this memory?' : 'Archive this memory?'} message={deleting.scope === 'personal' ? 'Your personal memory is permanently deleted.' : 'You can restore this team memory from Archive.'} confirmLabel={deleting.scope === 'personal' ? 'Delete' : 'Archive'} destructive busy={task.busy} error={task.error} onClose={() => setDeleting(undefined)} onConfirm={() => void task.run(async () => { await remove({ id: deleting.id }); setDeleting(undefined); })} />}
  {history && <MemoryHistory memory={history} onClose={() => setHistory(undefined)} />}
  </>;
}
function MemoryHistory({ memory, onClose }: { memory: MemoryRow; onClose: () => void }) {
  const versions = useQuery(api.memory.versions, { id: memory.id });
  const restore = useMutation(api.memory.restoreVersion);
  const task = useTask();
  return <EditorSheet title="Memory history" busy={task.busy} onClose={onClose}>{task.error && <ErrorState message={task.error} />}{versions ? versions.map(v => <Card key={v._id}><Text tone="muted">{new Date(v.savedAt).toLocaleString()} · {v.savedByName}</Text><Text selectable>{v.content}</Text><Button label="Restore this version" variant="secondary" disabled={task.busy} onPress={() => void task.run(async () => { await restore({ versionId: v._id, expectedVersion: memory.version }); onClose(); })} /></Card>) : <Loading />}</EditorSheet>;
}
