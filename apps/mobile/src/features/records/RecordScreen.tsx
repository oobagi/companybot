import { usePinAction } from '@/features/pins/usePins';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import { useState } from 'react';
import { router, Stack as RouterStack } from 'expo-router';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import type { FieldValue } from '@companybot/core/records';
import { Button, Card, ConfirmSheet, EditorSheet, EmptyState, ErrorState, SettingsList, Loading, Screen, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import type { SettingsSection } from '@/components/ui/SettingsList';
import type { Action } from '@/components/ui/ActionMenu';
import { useConfirm } from '@/components/ui/useConfirm';
import { FieldForm } from './DatabaseForms';
import { ValueForm } from './ValueEditor';
import { valueText, type RecordDetail, type TypeField } from './model';
import { recordCapabilities } from './access';

export function RecordScreen({ recordId }: { recordId: string }) {
  const record = useQuery(api.records.get, { recordId: recordId as Id<'records'> });
  if (record === undefined) return <Screen><Loading /></Screen>;
  if (!record) return <Screen><EmptyState title="Record unavailable" description="It may have been deleted or belong to another workspace." /></Screen>;
  return <RecordContent key={record._id} record={record} />;
}

function RecordContent({ record }: { record: RecordDetail }) {
  const pin = usePinAction(`rec:${record._id}`);
  const me = useQuery(api.workspace.me);
  const databases = useQuery(api.recordTypes.list);
  const type = databases?.find(t => t._id === record.typeId);
  const update = useMutation(api.records.update);
  const move = useMutation(api.trash.move);
  const restore = useMutation(api.trash.restore);
  const createPage = useMutation(api.pages.create);
  const cancelFollowup = useMutation(api.wakeups.cancel);
  const pageId = useQuery(api.pages.forRecord, { recordId: record._id });
  const followups = useQuery(api.wakeups.list, { recordId: record._id });
  const discussion = useQuery(api.records.discussion, { recordId: record._id });
  const linked = usePaginatedQuery(api.records.linked, { recordId: record._id }, { initialNumItems: 10 });
  const task = useTask();
  const [archive, setArchive] = useState(false);
  const [history, setHistory] = useState(false);
  const [field, setField] = useState<TypeField | 'new'>();
  const [editing, setEditing] = useState<TypeField>();
  const [pendingFollowup, setPendingFollowup] = useState<Id<'wakeups'>>();
  const capabilities = recordCapabilities(me?.access, record);
  const missing = record.unresolved.slice(0, 200);
  const resolved = useQuery(api.records.refs, missing.length ? { ids: missing } : 'skip');
  const refs = { ...record.refs, ...resolved };
  const openNotes = () => void task.run(async () => {
    const id = pageId ?? (capabilities.notes ? await createPage({ recordId: record._id }) : undefined);
    if (id) router.push({ pathname: '/pages/[pageId]', params: { pageId: id } });
  });
  const fieldsToManage = !record.archived ? record.fields.filter(f => type?.fields.find(candidate => candidate._id === f._id)?.canEdit) : [];
  const actions: Action[] = [
    { id: 'pin', title: pin.label, disabled: pin.disabled, icon: 'pin' },
    { id: 'history', title: 'Property history', icon: 'clock.arrow.circlepath' },
    ...(fieldsToManage.length ? [{ id: 'fields', title: 'Edit fields', icon: 'pencil' as const, items: fieldsToManage.map(f => ({ id: `field:${f._id}`, title: f.label })) }] : []),
    ...(!record.archived && type?.canManage ? [{ id: 'new-field', title: 'Add field', icon: 'plus' as const }] : []),
    ...(capabilities.edit ? [{ id: 'archive', title: 'Archive record', icon: 'archivebox' as const, destructive: true }] : []),
    ...(record.archived && record.trash?.canRestore ? [{ id: 'restore', title: 'Restore record', icon: 'arrow.uturn.backward' as const }] : []),
  ];
  const sections: SettingsSection[] = [
    ...(record.archived ? [{ id: 'archived', rows: [{ id: 'status', title: 'Archived', subtitle: 'Properties, notes and history are kept.' }] }] : []),
    { id: 'properties', title: 'Properties', rows: record.fields.flatMap(f => [
      { id: f.key, title: f.label, subtitle: valueText(f, record.values[f.key], refs), onPress: capabilities.edit ? () => setEditing(f) : undefined, testID: `record-property-${f.key}` },
      ...(f.kind === 'link' ? (Array.isArray(record.values[f.key]) ? record.values[f.key] as string[] : typeof record.values[f.key] === 'string' ? [record.values[f.key] as string] : []).filter(id => refs[id] && !refs[id].archived).map(id => ({ id: `${f.key}:${id}`, title: refs[id].name, subtitle: `Linked in ${f.label}`, onPress: () => router.push(`/record/${id}`) })) : []),
    ]) },
    { id: 'notes', rows: [{ id: 'notes', title: pageId || !capabilities.notes ? 'Notes' : 'Add notes', subtitle: pageId === undefined ? 'Loading…' : !pageId && !capabilities.notes ? 'No notes' : undefined, disabled: task.busy || pageId === undefined, onPress: pageId || capabilities.notes ? openNotes : undefined, testID: 'record-notes' }] },
  ];
  if (followups?.length) sections.push({ id: 'followups', title: 'Follow-ups', rows: followups.map(row => ({ id: row._id, title: row.note ?? 'Agent check-in', subtitle: `${row.agent} · ${row.at ? new Date(row.at).toLocaleString() : 'When the job finishes'}${row.held ? ' · On hold' : ''}`, onPress: row.canCancel ? () => { task.clear(); setPendingFollowup(row._id); } : undefined, accessibilityHint: row.canCancel ? 'Review cancellation' : undefined })) });
  if (linked.results.length || linked.status !== 'Exhausted') sections.push({ id: 'linked', title: 'Linked records', rows: [
    ...linked.results.map(row => ({ id: `${row._id}:${row.fieldId}`, title: row.title, onPress: () => router.push(`/record/${row._id}`) })),
    ...(linked.status === 'CanLoadMore' ? [{ id: 'more', title: 'Load more linked records', onPress: () => linked.loadMore(10) }] : linked.status === 'LoadingFirstPage' || linked.status === 'LoadingMore' ? [{ id: 'loading', title: 'Loading…', disabled: true }] : []),
  ] });
  if (discussion?.length) sections.push({ id: 'discussion', title: 'Discussion', rows: discussion.map(message => ({ id: message.messageId, title: message.author, subtitle: message.text, onPress: () => router.push(message.threadId ? { pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: message.chatId, threadId: message.threadId, messageId: message.messageId } } : { pathname: '/chat/[chatId]', params: { chatId: message.chatId, messageId: message.messageId } }) })) });
  return <>
    <RouterStack.Screen options={{ title: record.title || record.type.name }} />
    <HeaderMenu label="Record actions" actions={actions.map(action => ({ ...action, disabled: action.disabled || task.busy }))} onAction={id => {
      if (id === 'pin') pin.onPress();
      else if (id === 'history') setHistory(true);
      else if (id === 'new-field') setField('new');
      else if (id.startsWith('field:')) setField(fieldsToManage.find(f => f._id === id.slice(6)));
      else if (id === 'archive') { task.clear(); setArchive(true); }
      else if (id === 'restore' && record.trash?.canRestore) void task.run(() => restore({ kind: 'record', id: record._id }));
    }} />
    <Screen nativeScroll padded={false}>
      {(pin.error || task.error) && <ErrorState message={pin.error ?? task.error!} />}
      <SettingsList sections={sections} />
    </Screen>
    {editing && capabilities.edit && <ValueForm key={editing.key} field={editing} value={record.values[editing.key]} refs={refs} onSave={next => update({ recordId: record._id, values: { [editing.key]: next } })} onClose={() => setEditing(undefined)} />}
    {field && !record.archived && type?.canManage && <FieldForm database={type} field={field === 'new' ? undefined : field} onClose={() => setField(undefined)} />}
    {history && <History record={record} canUndo={capabilities.undo} onClose={() => setHistory(false)} />}
    {archive && <ConfirmSheet title="Archive record?" message="Its properties, notes and history are kept. Restore it at any time from Archive." confirmLabel="Archive" busy={task.busy} error={task.error} onClose={() => setArchive(false)} onConfirm={() => void task.run(async () => { await move({ kind: 'record', id: record._id }); setArchive(false); })} />}
    {pendingFollowup && <ConfirmSheet title="Cancel follow-up?" message="The agent will no longer check back for this follow-up." confirmLabel="Cancel follow-up" busy={task.busy} error={task.error} onClose={() => setPendingFollowup(undefined)} onConfirm={() => void task.run(async () => { await cancelFollowup({ id: pendingFollowup }); setPendingFollowup(undefined); })} />}
  </>;
}

function History({ record, canUndo, onClose }: { record: RecordDetail; canUndo: boolean; onClose: () => void }) {
  const { results, status, loadMore } = usePaginatedQuery(api.records.history, { recordId: record._id }, { initialNumItems: 20 });
  const undo = useMutation(api.records.undo);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  return <EditorSheet title="Property history" onClose={onClose} busy={task.busy}>
    {dialog}
    {task.error && <ErrorState message={task.error} />}
    {results.map(entry => <Card key={entry._id}><Text variant="label">{entry.undoes ? 'Undid a change' : entry.action[0].toUpperCase() + entry.action.slice(1)}</Text><Text variant="caption" tone="muted">{entry.agent ? `${entry.agent}, for ` : ''}{entry.user} · {new Date(entry.time).toLocaleString()}</Text>
      {entry.changes.map(change => { const field = record.fields.find(f => f.key === change.key); return <Text key={change.key}>{change.label}: {valueText(field, change.old as FieldValue | undefined, entry.refs)} → {valueText(field, change.new as FieldValue | undefined, entry.refs)}</Text>; })}
      {entry.undone ? <Text tone="muted">Undone</Text> : canUndo && <Button label="Undo change" variant="secondary" disabled={task.busy} onPress={() => void task.run(async () => {
        if ((entry.action === 'created' || entry.action === 'restored') && !await confirm({ title: 'Undo and archive?', body: 'Undoing this change archives the record. Its content is kept and can be restored.', action: 'Undo change', danger: true })) return;
        await undo({ historyId: entry._id });
      })} />}
    </Card>)}
    {status === 'LoadingFirstPage' || status === 'LoadingMore' ? <Loading layout={results.length ? 'inline' : 'screen'} /> : status === 'CanLoadMore' ? <Button label="Load more history" variant="ghost" onPress={() => loadMore(20)} /> : null}
  </EditorSheet>;
}
