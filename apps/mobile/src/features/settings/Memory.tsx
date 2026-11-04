import { useState } from 'react';
import { FlatList } from 'react-native';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { Badge, Button, Card, ChoicePicker, ConfirmSheet, EditorSheet, EmptyState, ErrorState, Field, Loading, Screen, Stack, Text } from '@/components/ui';

type MemoryRow = FunctionReturnType<typeof api.memory.list>[number];
export default function Memory() {
  const memories = useQuery(api.memory.list);
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
  const [scope, setScope] = useState<'workspace' | 'personal'>('workspace');
  const [baseline, setBaseline] = useState('');
  const draft = JSON.stringify(editing === 'new' ? { content, agentId, scope } : { content });
  const guard = useDraftGuard({ dirty: !!editing && draft !== baseline, busy: !!editing && task.busy, onClose: () => setEditing(undefined) });
  if (!memories || !agents) return <Loading />;
  return <Screen><Stack style={{ flex: 1 }}><Button label="New memory" onPress={() => { task.clear(); setEditing('new'); setContent(''); setAgentId(agents[0]?._id ?? ''); setScope('workspace'); setBaseline(JSON.stringify({ content: '', agentId: agents[0]?._id ?? '', scope: 'workspace' })); }} /><Field label="Search memories" value={search} onChangeText={setSearch} />
    <FlatList data={memories.filter(m => m.content.toLowerCase().includes(search.toLowerCase()))} keyExtractor={m => m.id} contentContainerStyle={{ flexGrow: 1, gap: 12 }} ListEmptyComponent={<EmptyState title="No memories" description="Agents remember useful context here. Personal memories are visible only to you." />} renderItem={({ item }) => <Card><Stack horizontal><Text variant="label" style={{ flex: 1 }}>{agents.find(a => a._id === item.agentId)?.name ?? 'Agent'}</Text><Badge label={item.scope === 'personal' ? 'Personal' : 'Team'} /></Stack><Text selectable>{item.content}</Text><Text tone="muted" variant="caption">Updated by {item.updatedByName}</Text>{item.canEdit && <><Button label="Edit" variant="secondary" onPress={() => { task.clear(); setContent(item.content); setBaseline(JSON.stringify({ content: item.content })); setEditing(item); }} /><Button label="History" variant="ghost" onPress={() => setHistory(item)} /><Button label={item.scope === 'personal' ? 'Delete' : 'Archive'} variant="danger" onPress={() => { task.clear(); setDeleting(item); }} /></>}</Card>} />
  </Stack>
  {editing && <EditorSheet title={editing === 'new' ? 'New memory' : 'Edit memory'} busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>{guard.dialog}{editing === 'new' && <><ChoicePicker label="Agent" value={agentId} options={agents.map(a => ({ value: a._id, label: a.name }))} onChange={v => { if (typeof v === 'string') setAgentId(v); }} /><ChoicePicker label="Who can see this?" value={scope} options={[{ value: 'workspace', label: 'Everyone in the workspace' }, { value: 'personal', label: 'Only you' }]} onChange={v => { if (v === 'workspace' || v === 'personal') setScope(v); }} /></>}<Field label="Memory" value={content} onChangeText={setContent} multiline style={{ minHeight: 180 }} />{task.error && <ErrorState message={task.error} />}<Button label="Save memory" loading={task.busy} disabled={!content.trim() || (editing === 'new' && !agentId)} onPress={() => void task.run(async () => { if (editing === 'new') await create({ agentId: agentId as Id<'agents'>, scope, content }); else await update({ id: editing.id, content, expectedVersion: editing.version }); setEditing(undefined); })} /></EditorSheet>}
  {deleting && <ConfirmSheet title={deleting.scope === 'personal' ? 'Delete this memory?' : 'Archive this memory?'} message={deleting.scope === 'personal' ? 'Your personal memory is permanently deleted.' : 'You can restore this team memory from Archive.'} confirmLabel={deleting.scope === 'personal' ? 'Delete' : 'Archive'} destructive busy={task.busy} error={task.error} onClose={() => setDeleting(undefined)} onConfirm={() => void task.run(async () => { await remove({ id: deleting.id }); setDeleting(undefined); })} />}
  {history && <MemoryHistory memory={history} onClose={() => setHistory(undefined)} />}
  </Screen>;
}
function MemoryHistory({ memory, onClose }: { memory: MemoryRow; onClose: () => void }) {
  const versions = useQuery(api.memory.versions, { id: memory.id });
  const restore = useMutation(api.memory.restoreVersion);
  const task = useTask();
  return <EditorSheet title="Memory history" busy={task.busy} onClose={onClose}>{task.error && <ErrorState message={task.error} />}{versions ? versions.map(v => <Card key={v._id}><Text tone="muted">{new Date(v.savedAt).toLocaleString()} · {v.savedByName}</Text><Text selectable>{v.content}</Text><Button label="Restore this version" variant="secondary" disabled={task.busy} onPress={() => void task.run(async () => { await restore({ versionId: v._id, expectedVersion: memory.version }); onClose(); })} /></Card>) : <Loading />}</EditorSheet>;
}
