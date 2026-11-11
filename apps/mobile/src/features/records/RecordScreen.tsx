import { usePinAction } from '@/features/pins/usePins';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import { useState, type ReactNode } from 'react';
import { useTheme } from '@/design';
import { router, Stack as RouterStack } from 'expo-router';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import type { FieldValue } from '@companybot/core/records';
import { Button, ConfirmSheet, Divider, EditorSheet, EmptyState, ErrorState, ListRow, PropertyRow, Loading, Screen, ScreenList, Section, Stack, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
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
  const { sizes, spacing } = useTheme();
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
  const liveEditing = editing && record.fields.find(f => f._id === editing._id);
  const liveDefinition = editing && type?.fields.find(f => f._id === editing._id);
  const valueDisabledReason = !capabilities.edit ? 'You can no longer edit this record. Your draft is kept here.' : editing && !liveEditing ? 'This field is no longer available. Your draft is kept here.' : liveDefinition?.changing ? 'This field is converting values. Try again when it finishes.' : undefined;
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
    ...(capabilities.edit ? [{ id: 'rename', title: 'Rename record', icon: 'pencil' as const }] : []),
    ...(fieldsToManage.length ? [{ id: 'fields', title: 'Edit fields', icon: 'pencil' as const, items: fieldsToManage.map(f => ({ id: `field:${f._id}`, title: f.label })) }] : []),
    ...(!record.archived && type?.canManage ? [{ id: 'new-field', title: 'Add field', icon: 'plus' as const }] : []),
    ...(capabilities.edit ? [{ id: 'archive', title: 'Archive record', icon: 'archivebox' as const, destructive: true }] : []),
    ...(record.archived && record.trash?.canRestore ? [{ id: 'restore', title: 'Restore record', icon: 'arrow.uturn.backward' as const }] : []),
  ];
  const sections: { id: string; content: ReactNode }[] = [
    { id: 'summary', content: <Stack gap="sm"><Text variant="supporting" tone="muted">{record.type.plural}</Text><Text variant="title" selectable>{record.title || record.type.name}</Text>{record.archived && <Text tone="muted">Archived. Properties, notes and history are kept.</Text>}</Stack> },
    { id: 'properties', content: <Section title="Properties"><Stack gap="none">{record.fields.filter(f => f.key !== 'name').map(f => {
      const converting = type?.fields.find(candidate => candidate._id === f._id)?.changing;
      const links = f.kind === 'link' ? (Array.isArray(record.values[f.key]) ? record.values[f.key] as string[] : typeof record.values[f.key] === 'string' ? [record.values[f.key] as string] : []) : [];
      return <Stack key={f.key} gap="none"><PropertyRow label={f.label} value={converting ? 'Converting…' : links.length ? `${links.length} linked ${links.length === 1 ? 'record' : 'records'}` : valueText(f, record.values[f.key], refs)} onPress={capabilities.edit ? () => setEditing(f) : undefined} disabled={converting || task.busy} />
        {links.map(id => <ListRow key={id} title={valueText(f, id, refs)} selectable={!refs[id] || !!refs[id].archived || !!refs[id].locked} disclosure={!!refs[id] && !refs[id].archived && !refs[id].locked} onPress={refs[id] && !refs[id].archived && !refs[id].locked ? () => router.push(`/record/${id}`) : undefined} />)}
      </Stack>;
    })}{record.fields.every(f => f.key === 'name') && <Text tone="muted">No properties yet.</Text>}</Stack></Section> },
    { id: 'notes', content: <ListRow title={pageId || !capabilities.notes ? 'Notes' : 'Add notes'} description={pageId === undefined ? 'Loading…' : pageId ? 'Open document' : !capabilities.notes ? 'No notes' : 'Write a document for this record.'} disabled={task.busy || pageId === undefined} disclosure={!!pageId || capabilities.notes} onPress={pageId || capabilities.notes ? openNotes : undefined} /> },
  ];
  if (followups?.length) sections.push({ id: 'followups', content: <Section title="Follow-ups"><Stack gap="none">{followups.map(row => <ListRow key={row._id} title={row.note ?? 'Agent check-in'} description={`${row.agent} · ${row.at ? new Date(row.at).toLocaleString() : 'When the job finishes'}${row.held ? ' · On hold' : ''}`} onPress={row.canCancel ? () => { task.clear(); setPendingFollowup(row._id); } : undefined} />)}</Stack></Section> });
  if (linked.results.length || linked.status !== 'Exhausted') sections.push({ id: 'linked', content: <Section title="Linked records"><Stack gap="none">
    {linked.results.map(row => <ListRow key={`${row._id}:${row.fieldId}`} title={row.title} description={databases?.find(db => db._id === row.typeId)?.plural} disclosure onPress={() => router.push(`/record/${row._id}`)} />)}
    {linked.status === 'CanLoadMore' ? <Button label="Load more linked records" variant="ghost" onPress={() => linked.loadMore(10)} /> : linked.status === 'LoadingFirstPage' || linked.status === 'LoadingMore' ? <Loading layout="inline" /> : null}
  </Stack></Section> });
  if (discussion?.length) sections.push({ id: 'discussion', content: <Section title="Discussion"><Stack gap="none">{discussion.map(message => <ListRow key={message.messageId} title={message.author} description={message.text} disclosure onPress={() => router.push(message.threadId ? { pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: message.chatId, threadId: message.threadId, messageId: message.messageId } } : { pathname: '/chat/[chatId]', params: { chatId: message.chatId, messageId: message.messageId } })} />)}</Stack></Section> });
  return <>
    <RouterStack.Screen options={{ title: record.title || record.type.name }} />
    <HeaderMenu label="Record actions" actions={actions.map(action => ({ ...action, disabled: action.disabled || task.busy }))} onAction={id => {
      if (id === 'pin') pin.onPress();
      else if (id === 'history') setHistory(true);
      else if (id === 'rename') setEditing(record.fields.find(f => f.key === 'name'));
      else if (id === 'new-field') setField('new');
      else if (id.startsWith('field:')) setField(fieldsToManage.find(f => f._id === id.slice(6)));
      else if (id === 'archive') { task.clear(); setArchive(true); }
      else if (id === 'restore' && record.trash?.canRestore) void task.run(() => restore({ kind: 'record', id: record._id }));
    }} />
    <Screen nativeScroll padded={false}>
      {(pin.error || task.error) && <ErrorState message={pin.error ?? task.error!} />}
      <ScreenList data={sections} keyExtractor={section => section.id} contentContainerStyle={{ paddingHorizontal: sizes.gutter, paddingVertical: spacing.lg, gap: spacing.xl }} renderItem={({ item }) => item.content} />
    </Screen>
    {editing && <ValueForm key={editing._id} field={liveEditing ?? editing} disabledReason={valueDisabledReason} value={record.values[editing.key]} refs={refs} onSave={next => update({ recordId: record._id, values: { [editing.key]: next } })} onClose={() => setEditing(undefined)} />}
    {field && type && <FieldForm database={type} field={field === 'new' ? undefined : field} onClose={() => setField(undefined)} />}
    {history && <History record={record} canUndo={capabilities.undo} onClose={() => setHistory(false)} />}
    {archive && <ConfirmSheet title="Archive record?" message="Its properties, notes and history are kept. Restore it at any time from Archive." confirmLabel="Archive" busy={task.busy} error={task.error} onClose={() => setArchive(false)} onConfirm={() => void task.run(async () => { await move({ kind: 'record', id: record._id }); setArchive(false); })} />}
    {pendingFollowup && <ConfirmSheet title="Cancel follow-up?" message="The agent will no longer check back for this follow-up." confirmLabel="Cancel follow-up" busy={task.busy} error={task.error} onClose={() => setPendingFollowup(undefined)} onConfirm={() => void task.run(async () => { await cancelFollowup({ id: pendingFollowup }); setPendingFollowup(undefined); })} />}
  </>;
}

function History({ record, canUndo, onClose }: { record: RecordDetail; canUndo: boolean; onClose: () => void }) {
  const { results, status, loadMore } = usePaginatedQuery(api.records.history, { recordId: record._id }, { initialNumItems: 20 });
  const [selected, setSelected] = useState<string>();
  const entry = results.find(item => item._id === selected);
  const undo = useMutation(api.records.undo);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const action = (item: typeof results[number]) => item.undoes ? 'Undid a change' : `${item.action[0].toUpperCase()}${item.action.slice(1)}`;
  return <EditorSheet title="Property history" onClose={onClose} busy={task.busy} scroll={!!selected}>
    {dialog}{task.error && <ErrorState message={task.error} />}
    {selected ? <>
      <Button label="All changes" variant="ghost" disabled={task.busy} onPress={() => { task.clear(); setSelected(undefined); }} />
      {!entry ? <EmptyState title="Change unavailable" /> : <>
        <Stack gap="xs"><Text variant="heading">{action(entry)}</Text><Text variant="supporting" tone="muted">{entry.agent ? `${entry.agent}, for ` : ''}{entry.user} · {new Date(entry.time).toLocaleString()}</Text></Stack>
        {entry.changes.map(change => { const field = record.fields.find(f => f.key === change.key); return <Section key={change.key} title={change.label}>
          <PropertyRow label="Before" value={valueText(field, change.old as FieldValue | undefined, entry.refs)} />
          <PropertyRow label="After" value={valueText(field, change.new as FieldValue | undefined, entry.refs)} />
        </Section>; })}
        {entry.undone ? <Text tone="muted">Undone</Text> : canUndo && <Button label="Undo change" variant="secondary" disabled={task.busy} onPress={() => void task.run(async () => {
          if ((entry.action === 'created' || entry.action === 'restored') && !await confirm({ title: 'Undo and archive?', body: 'Undoing this change archives the record. Its content is kept and can be restored.', action: 'Undo change', danger: true })) return;
          await undo({ historyId: entry._id });
        })} />}
      </>}
    </> : <ScreenList data={results} keyExtractor={entry => entry._id} ItemSeparatorComponent={Divider} renderItem={({ item }) => <ListRow title={action(item)} description={`${item.agent ? `${item.agent}, for ` : ''}${item.user} · ${new Date(item.time).toLocaleString()}`} value={item.undone ? 'Undone' : undefined} disclosure onPress={() => setSelected(item._id)} />}
      ListEmptyComponent={status === 'LoadingFirstPage' || status === 'LoadingMore' ? <Loading /> : <EmptyState title="No property changes" description={status === 'CanLoadMore' ? 'Load more to check earlier history.' : undefined} />}
      ListFooterComponent={status === 'CanLoadMore' ? <Button label="Load more history" variant="ghost" onPress={() => loadMore(20)} /> : status === 'LoadingMore' && results.length ? <Loading layout="inline" /> : undefined} />}
  </EditorSheet>;
}
