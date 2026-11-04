import { ReorderSheet } from '@/features/arrangements/ReorderSheet';
import { usePinAction } from '@/features/pins/usePins';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { useArrangements } from '@/features/arrangements/useArrangements';
import { DirectoryHeader } from '@/components/navigation/DirectoryHeader';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Board } from './Board';
import { RecordCard } from './RecordCard';
import { router, Stack as RouterStack } from 'expo-router';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { can } from '@companybot/core/permissions';
import { Button, ChoicePicker, EditorSheet, EmptyState, ErrorState, Field, Loading, Screen, ScreenList, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery, useWorkspace } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { DatabaseForm, FieldForm } from './DatabaseForms';
import { allRecordsView, changedDisplay, defaultView, groupable, type Database, type ViewConfig } from './model';
import { ViewEditor } from './ViewEditor';
import { useDeviceView } from './useDeviceView';
import { AccessSheet } from '@/features/access/AccessSheet';

export function DatabaseScreen({ typeId }: { typeId: string }) {
  const databases = useQuery(api.recordTypes.list);
  if (databases === undefined) return <Loading />;
  const database = databases.find(d => d._id === typeId);
  if (!database) return <EmptyState title="Database unavailable" description="It may have been archived or belong to another workspace." />;
  return <DatabaseContent key={database._id} database={database} />;
}

function DatabaseContent({ database }: { database: Database }) {
  const pin = usePinAction(`db:${database.key}`);
  const me = useQuery(api.workspace.me);
  const workspace = useWorkspace();
  const settings = useQuery(api.workspace.settings);
  const views = useQuery(api.databaseViews.list, { typeId: database._id });
  const setAccess = useMutation(api.recordTypes.setAccess);
  const setDisplay = useMutation(api.recordTypes.setDisplay);
  const arrangements = useArrangements();
  const changeArrangement = useMutation(api.arrangements.change);
  const storedColumns = arrangements.rows.find(row => row.list === 'columns' && row.entityId === database._id)?.ids;
  const columns = (storedColumns?.length ? storedColumns : defaultView(database).columns).filter(key => database.fields.some(field => field.key === key && !field.archived));
  const canArrange = !!me?.access && can(me.access, 'sidebar.arrange');
  const [selected, setSelected] = useState('');
  const [selectedVersion, setSelectedVersion] = useState<number>();
  const [sharedConfig, setSharedConfig] = useState<ViewConfig>(() => defaultView(database));
  const device = useDeviceView(workspace!.id, database, settings?.currency);
  const config = selected ? sharedConfig : allRecordsView(device.config, database.display, columns);
  const setConfig = (next: ViewConfig) => { if (selected) setSharedConfig(next); else device.set(next); };
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'view' | 'database' | 'create' | 'field' | 'access' | 'organize'>();
  const { spacing } = useTheme();
  const editable = database.canEdit;
  const liveFields = database.fields.filter(f => !f.archived);
  const groupField = liveFields.find(f => f.key === config.groupBy && groupable(f)) ?? liveFields.find(groupable);
  const searchResults = useQuery(api.records.search, search.trim() ? { typeId: database._id, query: search.trim() } : 'skip');
  const board = config.layout === 'board' && !search.trim();
  const { results, status, loadMore } = usePaginatedQuery(api.records.list, board || search.trim() || !device.loaded ? 'skip' : { typeId: database._id, filters: config.filters, sort: config.sort }, { initialNumItems: 25 });
  // Selective filters may return empty/short pages without exhausting their indexed scan.
  useEffect(() => { if (!board && !search.trim() && status === 'CanLoadMore' && results.length < 25) loadMore(25); }, [board, search, status, results.length, loadMore]);
  const rows = search.trim() ? searchResults ?? [] : results;
  const missing = [...new Set(rows.flatMap(row => row.unresolved))].slice(0, 200);
  const resolved = useQuery(api.records.refs, missing.length ? { ids: missing } : 'skip');
  const current = views?.find(view => view._id === selected);
  // Capture a base once after creating/saving a view; later remote versions never silently rebase a local draft.
  if (current && selectedVersion === undefined) setSelectedVersion(current.version);
  const header = <Stack gap="md">
    <ChoicePicker label="View" value={selected || 'all'} options={[{ value: 'all', label: 'All records' }, ...arrangements.order('views', views ?? [], database._id).map(v => ({ value: v._id, label: v.name }))]} onChange={value => {
      if (typeof value !== 'string' || !value) return;
      const view = views?.find(v => v._id === value); setSelected(view?._id ?? ''); setSelectedVersion(view?.version); if (view) setSharedConfig({ filters: view.filters, sort: view.sort, columns: view.columns, layout: view.layout ?? 'table', groupBy: view.groupBy });
    }} />
    {search.trim() && <Text variant="caption" tone="muted">Top 20 search matches. View filters and sorting are paused while searching.</Text>}
    {pin.error && <ErrorState message={pin.error} />}
    {device.error && <ErrorState message={device.error} />}
  </Stack>;
  if (!device.loaded || !arrangements.loaded) return <Loading label="Opening database…" />;
  return <Screen nativeScroll={!board} padded={false}>
    <RouterStack.Screen options={{ title: database.plural }} />
    <DirectoryHeader workspaceSwitcher={false} search={{ placeholder: `Search ${database.plural.toLowerCase()}`, value: search, onChange: setSearch }} action={editable ? { label: `New ${database.name.toLowerCase()}`, onPress: () => setMode('create') } : undefined} menu={[
      { label: pin.label, disabled: pin.disabled, onPress: pin.onPress },
      ...(canArrange ? [{ label: 'Organize views', onPress: () => setMode('organize') }] : []),
      { label: 'View options', onPress: () => setMode('view') },
      { label: 'Who can access', onPress: () => setMode('access') },
      ...(database.canManage ? [{ label: 'Add field', onPress: () => setMode('field') }, { label: 'Edit database', onPress: () => setMode('database') }] : []),
    ]} />
    {board ? <><View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>{header}</View>{groupField ? <Board key={JSON.stringify([database._id, groupField.key, config.filters, config.sort])} database={database} config={config} group={groupField} /> : <EmptyState title="Choose a field for this board" description="Boards group records by a single-choice field." action={database.canManage ? <Button label="Add field" onPress={() => setMode('field')} /> : undefined} />}</> : <ScreenList data={rows} keyExtractor={item => item._id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }} ListHeaderComponent={header}
      renderItem={({ item }) => <RecordCard row={item} database={database} config={config} refs={{ ...item.refs, ...resolved }} />}
      onEndReached={() => { if (!board && !search.trim() && status === 'CanLoadMore') loadMore(25); }} onEndReachedThreshold={0.5}
      ListEmptyComponent={search.trim() ? searchResults === undefined ? <Loading /> : <EmptyState title="No matches" /> : status === 'LoadingFirstPage' || status === 'LoadingMore' || status === 'CanLoadMore' ? <Loading /> : <EmptyState title={config.filters.length ? 'No matching records' : 'No records yet'} />}
      ListFooterComponent={!search.trim() && status === 'CanLoadMore' ? <Button label="Load more" variant="ghost" onPress={() => loadMore(25)} /> : status === 'LoadingMore' ? <Text tone="muted">Loading more…</Text> : undefined} />}
    {mode === 'view' && <ViewEditor database={database} value={config} view={editable ? current : undefined} baseVersion={selectedVersion} sharedDisplay={!selected ? { editable: canArrange } : undefined} onApply={async (next, id, baseline) => { if (!selected && id === undefined) { const display = changedDisplay(next, baseline ?? config); if (Object.keys(display).length) await setDisplay({ typeId: database._id, display }); const previous = baseline?.columns ?? config.columns; const seed = storedColumns?.length ? undefined : previous; for (const key of next.columns.filter(key => !previous.includes(key))) await changeArrangement({ list: 'columns', entityId: database._id, command: { op: 'add', id: key, seed } }); for (const key of previous.filter(key => !next.columns.includes(key))) await changeArrangement({ list: 'columns', entityId: database._id, command: { op: 'remove', id: key, seed } }); } setConfig(next); if (id !== undefined) { setSelected(id); setSelectedVersion(undefined); if (id) setSharedConfig(next); } }} onClose={() => setMode(undefined)} canSave={editable} />}
    {mode === 'organize' && <ReorderSheet title="Organize views" list="views" entityId={database._id} items={(views ?? []).map(view => ({ _id: view._id, title: view.name }))} currentId={selected} loading={views === undefined} onClose={() => setMode(undefined)} />}
    {mode === 'database' && database.canManage && <DatabaseForm database={database} onClose={() => setMode(undefined)} />}
    {mode === 'access' && <AccessSheet access={database.access} onSave={database.canManage ? entries => setAccess({ typeId: database._id, access: entries ?? [] }) : undefined} onClose={() => setMode(undefined)} />}
    {mode === 'field' && database.canManage && <FieldForm database={database} onClose={() => setMode(undefined)} />}
    {mode === 'create' && editable && <CreateRecord database={database} onClose={() => setMode(undefined)} />}
  </Screen>;
}

function CreateRecord({ database, onClose }: { database: Database; onClose: () => void }) {
  const [name, setName] = useState('');
  const create = useMutation(api.records.create);
  const task = useTask();
  const guard = useDraftGuard({ dirty: !!name, busy: task.busy, onClose });
  return <EditorSheet title={`New ${database.name.toLowerCase()}`} dismissible={guard.dismissible} onClose={() => void guard.close()} busy={task.busy}>
    {guard.dialog}
    {task.error && <ErrorState message={task.error} />}
    <Field label="Name" value={name} onChangeText={setName} editable={!task.busy} autoFocus />
    <Button label="Create" disabled={!name.trim()} loading={task.busy} onPress={() => void task.run(async () => { const id = await create({ typeId: database._id as Id<'recordTypes'>, values: { name: name.trim() } }); onClose(); router.push(`/record/${id}`); })} />
  </EditorSheet>;
}
