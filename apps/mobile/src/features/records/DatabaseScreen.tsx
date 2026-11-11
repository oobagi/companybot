import { ReorderSheet } from '@/features/arrangements/ReorderSheet';
import { usePinAction } from '@/features/pins/usePins';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { useArrangements } from '@/features/arrangements/useArrangements';
import { DirectoryHeader } from '@/features/session/DirectoryHeader';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Board } from './Board';
import { RecordCard } from './RecordCard';
import { router, Stack as RouterStack } from 'expo-router';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { can } from '@companybot/core/permissions';
import { Button, ChoicePicker, Divider, EditorSheet, EmptyState, ErrorState, Field, Loading, Screen, ScreenList, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery, useWorkspace } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { DatabaseForm, FieldForm } from './DatabaseForms';
import { activeView, groupable, type Database } from './model';
import { ViewEditor } from './ViewEditor';
import { useDeviceView } from './useDeviceView';
import { AccessSheet } from '@/features/access/AccessSheet';

export function DatabaseScreen({ typeId }: { typeId: string }) {
  const databases = useQuery(api.recordTypes.list);
  if (databases === undefined) return <Screen><Loading label="Opening database…" /></Screen>;
  const database = databases.find(d => d._id === typeId);
  if (!database) return <Screen><EmptyState title="Database unavailable" description="It may have been archived or belong to another workspace." /></Screen>;
  return <DatabaseContent key={database._id} database={database} />;
}

function DatabaseContent({ database }: { database: Database }) {
  const pin = usePinAction(`db:${database.key}`);
  const me = useQuery(api.workspace.me);
  const workspace = useWorkspace();
  const settings = useQuery(api.workspace.settings);
  const views = useQuery(api.databaseViews.list, { typeId: database._id });
  const setAccess = useMutation(api.recordTypes.setAccess);
  const arrangements = useArrangements();
  const canArrange = !!me?.access && can(me.access, 'sidebar.arrange');
  const [selected, setSelected] = useState<string>();
  const orderedViews = arrangements.order('views', views ?? [], database._id);
  const current = activeView(orderedViews, selected);
  const device = useDeviceView(workspace!.id, database, settings?.currency, current);
  const config = device.config;
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<'view' | 'database' | 'create' | 'field' | 'access' | 'organize'>();
  const { spacing, sizes } = useTheme();
  const editable = database.canEdit;
  const liveFields = database.fields.filter(f => !f.archived);
  const groupField = liveFields.find(f => f.key === config.groupBy && groupable(f)) ?? liveFields.find(groupable);
  const searchResults = useQuery(api.records.search, search.trim() ? { typeId: database._id, query: search.trim() } : 'skip');
  const board = config.layout === 'board' && !search.trim();
  const { results, status, loadMore } = usePaginatedQuery(api.records.list, board || search.trim() || !current || !device.loaded ? 'skip' : { typeId: database._id, filters: config.filters, sort: config.sort }, { initialNumItems: 25 });
  // Selective filters may return empty/short pages without exhausting their indexed scan.
  useEffect(() => { if (!board && !search.trim() && status === 'CanLoadMore' && results.length < 25) loadMore(25); }, [board, search, status, results.length, loadMore]);
  const rows = search.trim() ? searchResults ?? [] : results;
  const missing = [...new Set(rows.flatMap(row => row.unresolved))].slice(0, 200);
  const resolved = useQuery(api.records.refs, missing.length ? { ids: missing } : 'skip');
  const sortField = config.sort && liveFields.find(field => field.key === config.sort?.field);
  const header = <Stack gap="sm">
    <ChoicePicker label="View" presentation="compact" disabled={views === undefined} value={current?._id ?? ''} options={orderedViews.map(v => ({ value: v._id, label: v.name }))} onChange={value => {
      if (typeof value === 'string' && orderedViews.some(view => view._id === value)) setSelected(value);
    }} />
    {device.local && <Text variant="supporting" tone={device.baseVersion !== current?.version ? 'danger' : 'muted'}>{device.baseVersion !== current?.version ? 'This shared view changed. Your device options are kept; reset them in View options before saving for everyone.' : 'View options apply on this device.'}</Text>}
    {search.trim() && <Text variant="caption" tone="muted">Top 20 search matches. View filters and sorting are paused while searching.</Text>}
    {!search.trim() && sortField && <Text variant="caption" tone="muted">Sorted by {sortField.label}. Records without a value aren’t shown.</Text>}
    {pin.error && <ErrorState message={pin.error} />}
    {device.error && <ErrorState message={device.error} />}
  </Stack>;
  if (views === undefined || !arrangements.loaded || (current && !device.loaded && mode !== 'view')) return <Screen><Loading label="Opening database…" /></Screen>;
  return <Screen nativeScroll={!board} padded={false}>
    <RouterStack.Screen options={{ title: database.plural }} />
    <DirectoryHeader workspaceSwitcher={false} search={{ placeholder: `Search ${database.plural.toLowerCase()}`, value: search, onChange: setSearch }} action={editable ? { label: `New ${database.name.toLowerCase()}`, onPress: () => setMode('create') } : undefined} menu={[
      { label: pin.label, disabled: pin.disabled, onPress: pin.onPress },
      ...(canArrange ? [{ label: 'Organize views', onPress: () => setMode('organize') }] : []),
      ...(current || editable ? [{ label: current ? 'View options' : 'Add view', onPress: () => setMode('view') }] : []),
      { label: 'Who can access', onPress: () => setMode('access') },
      ...(database.canManage ? [{ label: 'Add field', onPress: () => setMode('field') }, { label: 'Edit database', onPress: () => setMode('database') }] : []),
    ]} />
    {current && <View style={{ paddingHorizontal: sizes.gutter, paddingBottom: spacing.sm }}>{header}</View>}
    {!current ? <EmptyState title="No views yet" description="A view shows this database’s records as a list or board." action={editable ? <Button label="Add view" onPress={() => setMode('view')} /> : undefined} /> : board ? groupField ? <Board key={JSON.stringify([database._id, groupField.key, config.filters, config.sort])} database={database} config={config} group={groupField} /> : <EmptyState title="Choose a field for this board" description="Boards group records by a single-choice field." action={database.canManage ? <Button label="Add field" onPress={() => setMode('field')} /> : undefined} /> : <ScreenList data={rows} keyExtractor={item => item._id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingHorizontal: sizes.gutter, paddingBottom: spacing.lg }} ItemSeparatorComponent={Divider}
      renderItem={({ item }) => <RecordCard row={item} database={database} config={config} refs={{ ...item.refs, ...resolved }} presentation="row" />}
      onEndReached={() => { if (!board && !search.trim() && status === 'CanLoadMore') loadMore(25); }} onEndReachedThreshold={0.5}
      ListEmptyComponent={search.trim() ? searchResults === undefined ? <Loading label="Searching records…" /> : <EmptyState title="No matches" description="Try a different name or text." /> : status === 'LoadingFirstPage' || status === 'LoadingMore' || status === 'CanLoadMore' ? <Loading label="Loading records…" /> : <EmptyState title={config.filters.length || config.sort ? 'No matching records' : `No ${database.plural.toLowerCase()} yet`} description={config.filters.length || config.sort ? 'Adjust this view’s filters or sorting to see more records.' : editable ? `Use the plus button to add your first ${database.name.toLowerCase()}.` : 'Records added by your team will appear here.'} />}
      ListFooterComponent={rows.length && !search.trim() ? status === 'CanLoadMore' ? <Button label="Load more" variant="ghost" onPress={() => loadMore(25)} /> : status === 'LoadingMore' ? <Loading layout="inline" label="Loading more…" /> : undefined : undefined} />}
    {mode === 'view' && <ViewEditor database={database} value={config} view={current} baseVersion={device.baseVersion} hasDeviceChanges={device.local} onReset={device.reset} onApply={async (next, id) => {
      if (id === undefined) await device.set(next);
      else {
        if (id === current?._id || id === '') await device.reset();
        setSelected(id || undefined);
      }
    }} onClose={() => setMode(undefined)} canSave={editable} />}
    {mode === 'organize' && <ReorderSheet title="Organize views" list="views" entityId={database._id} items={(views ?? []).map(view => ({ _id: view._id, title: view.name }))} currentId={current?._id} loading={views === undefined} onClose={() => setMode(undefined)} />}
    {mode === 'database' && database.canManage && <DatabaseForm database={database} onClose={() => setMode(undefined)} />}
    {mode === 'access' && <AccessSheet access={database.access} onSave={database.canManage ? entries => setAccess({ typeId: database._id, access: entries ?? [] }) : undefined} onClose={() => setMode(undefined)} />}
    {mode === 'field' && <FieldForm database={database} onClose={() => setMode(undefined)} />}
    {mode === 'create' && editable && <CreateRecord database={database} onClose={() => setMode(undefined)} />}
  </Screen>;
}

function CreateRecord({ database, onClose }: { database: Database; onClose: () => void }) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<Id<'records'>>();
  const create = useMutation(api.records.create);
  const task = useTask();
  const busy = task.busy || !!created;
  const guard = useDraftGuard({ dirty: !!name, busy, onClose });
  return <EditorSheet title={`New ${database.name.toLowerCase()}`} size="content" open={!created} dismissible={guard.dismissible} onClose={() => void guard.close()} busy={busy}
    onDismiss={() => { if (created) { guard.complete(); onClose(); router.push(`/record/${created}`); } }}
    submit={{ label: 'Create', disabled: !name.trim(), onPress: () => { if (!busy && name.trim()) void task.run(async () => setCreated(await create({ typeId: database._id, values: { name: name.trim() } }))); } }}>
    {guard.dialog}
    {task.error && <ErrorState message={task.error} />}
    <Field label="Name" value={name} onChangeText={setName} editable={!busy} autoFocus />
  </EditorSheet>;
}
