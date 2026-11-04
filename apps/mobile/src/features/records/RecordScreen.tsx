import { useState } from 'react';
import { View } from 'react-native';
import { router, Stack as RouterStack } from 'expo-router';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import type { FieldValue } from '@companybot/core/records';
import { Button, Card, ConfirmSheet, EditorSheet, EmptyState, ErrorState, ListRow, Loading, Screen, Section, Stack, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { DocumentEditor } from '@/features/documents/DocumentEditor';
import { FieldForm } from './DatabaseForms';
import { ValueEditor } from './ValueEditor';
import { valueText, type RecordDetail, type TypeField } from './model';
import { recordCapabilities } from './access';

export function RecordScreen({ recordId }: { recordId: string }) {
  const record = useQuery(api.records.get, { recordId: recordId as Id<'records'> });
  if (record === undefined) return <Loading />;
  if (!record) return <EmptyState title="Record unavailable" description="It may have been deleted or belong to another workspace." />;
  return <RecordContent key={record._id} record={record} />;
}

function RecordContent({ record }: { record: RecordDetail }) {
  const me = useQuery(api.workspace.me);
  const databases = useQuery(api.recordTypes.list);
  const type = databases?.find(t => t._id === record.typeId);
  const update = useMutation(api.records.update);
  const move = useMutation(api.trash.move);
  const restore = useMutation(api.trash.restore);
  const task = useTask();
  const [archive, setArchive] = useState(false);
  const [history, setHistory] = useState(false);
  const [field, setField] = useState<TypeField | 'new'>();
  const capabilities = recordCapabilities(me?.access, record);
  const editable = capabilities.edit;
  const missing = record.unresolved.slice(0, 200);
  const resolved = useQuery(api.records.refs, missing.length ? { ids: missing } : 'skip');
  const refs = { ...record.refs, ...resolved };
  return <Screen scroll keyboard>
    <RouterStack.Screen options={{ title: record.type.name }} />
    <Stack gap="xl">
      <Text variant="title" accessibilityRole="header">{record.title}</Text>
      {task.error && <ErrorState message={task.error} />}
      {record.archived && <Card><Text>This record is archived. Its content is kept.</Text>{record.trash?.canRestore && <Button label="Restore record" loading={task.busy} onPress={() => void task.run(async () => { await restore({ kind: 'record', id: record._id }); })} />}</Card>}
      <Section title="Properties">
        {record.fields.map(f => <Stack key={f.key} gap="xs">
          {editable ? <ValueEditor field={f} value={record.values[f.key]} refs={refs} onSave={next => update({ recordId: record._id, values: { [f.key]: next } })} /> : <ListRow title={f.label} description={valueText(f, record.values[f.key], refs)} />}
          {f.kind === 'link' && (Array.isArray(record.values[f.key]) ? record.values[f.key] as string[] : typeof record.values[f.key] === 'string' ? [record.values[f.key] as string] : []).filter(id => refs[id] && !refs[id].archived).map(id => <Button key={id} label={`Open ${refs[id].name}`} variant="ghost" onPress={() => router.push(`/record/${id}`)} />)}
          {!record.archived && type?.fields.find(candidate => candidate._id === f._id)?.canEdit && <Button label={`Edit ${f.label} field`} variant="ghost" onPress={() => setField(f)} />}
        </Stack>)}
        {!record.archived && type?.canManage && <Button label="Add field" variant="secondary" onPress={() => setField('new')} />}
      </Section>
      <RecordBody recordId={record._id} editable={capabilities.notes} />
      <Followups recordId={record._id} />
      <LinkedRecords recordId={record._id} />
      <Discussion recordId={record._id} />
      <Button label="History" variant="secondary" onPress={() => setHistory(true)} />
      {editable && <Button label="Archive record" variant="ghost" onPress={() => setArchive(true)} />}
    </Stack>
    {field && type?.canManage && <FieldForm database={type} field={field === 'new' ? undefined : field} onClose={() => setField(undefined)} />}
    {history && <History record={record} canUndo={capabilities.undo} onClose={() => setHistory(false)} />}
    {archive && <ConfirmSheet title="Archive record?" message="Its properties, notes and history are kept. Restore it at any time from Archive." confirmLabel="Archive" busy={task.busy} error={task.error} onClose={() => setArchive(false)} onConfirm={() => void task.run(async () => { await move({ kind: 'record', id: record._id }); setArchive(false); })} />}
  </Screen>;
}

function RecordBody({ recordId, editable }: { recordId: Id<'records'>; editable: boolean }) {
  const pageId = useQuery(api.pages.forRecord, { recordId });
  const create = useMutation(api.pages.create);
  const task = useTask();
  return <Section title="Notes">
    {task.error && <ErrorState message={task.error} />}
    {pageId ? <View style={{ height: 400 }}><DocumentEditor pageId={pageId} editable={editable} /></View> : pageId === undefined ? <Loading layout="inline" label="Loading notes…" /> : editable ? <Button label="Add notes" variant="secondary" loading={task.busy} onPress={() => void task.run(() => create({ recordId }))} /> : <Text tone="muted">No notes.</Text>}
  </Section>;
}

function LinkedRecords({ recordId }: { recordId: Id<'records'> }) {
  const { results, status, loadMore } = usePaginatedQuery(api.records.linked, { recordId }, { initialNumItems: 10 });
  if (status === 'Exhausted' && !results.length) return null;
  return <Section title="Linked records">{results.map(row => <ListRow key={`${row._id}:${row.fieldId}`} title={row.title} onPress={() => router.push(`/record/${row._id}`)} />)}
    {status === 'LoadingFirstPage' || status === 'LoadingMore' ? <Text tone="muted">Loading…</Text> : status === 'CanLoadMore' ? <Button label="Load more linked records" variant="ghost" onPress={() => loadMore(10)} /> : null}
  </Section>;
}

function Discussion({ recordId }: { recordId: Id<'records'> }) {
  const messages = useQuery(api.records.discussion, { recordId });
  if (!messages?.length) return null;
  return <Section title="Discussion">{messages.map(m => <ListRow key={m.messageId} title={m.author} description={m.text} onPress={() => router.push(m.threadId ? { pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: m.chatId, threadId: m.threadId } } : { pathname: '/chat/[chatId]', params: { chatId: m.chatId, messageId: m.messageId } })} />)}</Section>;
}

function Followups({ recordId }: { recordId: Id<'records'> }) {
  const rows = useQuery(api.wakeups.list, { recordId });
  const cancel = useMutation(api.wakeups.cancel);
  const task = useTask();
  const [pending, setPending] = useState<Id<'wakeups'>>();
  if (!rows?.length) return null;
  return <Section title="Follow-ups">{rows.map(row => <Card key={row._id}><Text variant="label">{row.note ?? 'Agent check-in'}</Text><Text tone="muted">{row.agent} · {row.at ? new Date(row.at).toLocaleString() : 'When the job finishes'}{row.held ? ' · On hold' : ''}</Text>{row.canCancel && <Button label="Cancel follow-up" variant="ghost" onPress={() => setPending(row._id)} />}</Card>)}
    {pending && <ConfirmSheet title="Cancel follow-up?" message="The agent will no longer check back for this follow-up." confirmLabel="Cancel follow-up" busy={task.busy} error={task.error} onClose={() => setPending(undefined)} onConfirm={() => void task.run(async () => { await cancel({ id: pending }); setPending(undefined); })} />}
  </Section>;
}

function History({ record, canUndo, onClose }: { record: RecordDetail; canUndo: boolean; onClose: () => void }) {
  const { results, status, loadMore } = usePaginatedQuery(api.records.history, { recordId: record._id }, { initialNumItems: 20 });
  const undo = useMutation(api.records.undo);
  const task = useTask();
  const [pending, setPending] = useState<Id<'recordHistory'>>();
  return <EditorSheet title="Property history" onClose={onClose} busy={task.busy}>
    {task.error && <ErrorState message={task.error} />}
    {results.map(entry => <Card key={entry._id}><Text variant="label">{entry.undoes ? 'Undid a change' : entry.action[0].toUpperCase() + entry.action.slice(1)}</Text><Text variant="caption" tone="muted">{entry.agent ? `${entry.agent}, for ` : ''}{entry.user} · {new Date(entry.time).toLocaleString()}</Text>
      {entry.changes.map(change => { const field = record.fields.find(f => f.key === change.key); return <Text key={change.key}>{change.label}: {valueText(field, change.old as FieldValue | undefined, entry.refs)} → {valueText(field, change.new as FieldValue | undefined, entry.refs)}</Text>; })}
      {entry.undone ? <Text tone="muted">Undone</Text> : canUndo && <Button label="Undo change" variant="secondary" disabled={task.busy} onPress={() => { if (entry.action === 'created' || entry.action === 'restored') setPending(entry._id); else void task.run(() => undo({ historyId: entry._id })); }} />}
    </Card>)}
    {status === 'LoadingFirstPage' || status === 'LoadingMore' ? <Loading layout={results.length ? 'inline' : 'screen'} /> : status === 'CanLoadMore' ? <Button label="Load more history" variant="ghost" onPress={() => loadMore(20)} /> : null}
    {pending && <ConfirmSheet title="Undo and archive?" message="Undoing this change archives the record. Its content is kept and can be restored." confirmLabel="Undo change" busy={task.busy} error={task.error} onClose={() => setPending(undefined)} onConfirm={() => void task.run(async () => { await undo({ historyId: pending }); setPending(undefined); })} />}
  </EditorSheet>;
}
