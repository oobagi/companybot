import { useState } from 'react';
import { Button, ChoicePicker, EditorSheet, ErrorState, Field, ListRow, Stack, Text } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { useConfirm } from '@/components/ui/useConfirm';
import { DateInput } from '@/components/ui/native-controls/DateInput';
import { localDateToCalendar } from '@/components/ui/native-controls/calendarDate';
import { normalizeViewConfig } from './deviceView';
import { groupable, sortable, type Database, type SavedView, type ViewConfig } from './model';
import { LinkPicker, UserPicker } from './ValueEditor';
import { buildFilter, draftFilter, replaceFilter, viewIsStale, type Condition, type FilterDraft } from './filters';

type FilterStep = { index: number | 'new'; initial: FilterDraft; draft: FilterDraft };

export function ViewEditor({ database, value, view: selectedView, baseVersion, onApply, onReset, onClose, canSave, hasDeviceChanges = false }: { database: Database; value: ViewConfig; view?: SavedView; baseVersion?: number; onApply: (config: ViewConfig, selected?: string) => void | Promise<void>; onReset: () => void | Promise<void>; onClose: () => void; canSave: boolean; hasDeviceChanges?: boolean }) {
  // A remote deletion must not turn an existing-view draft into a new-view creation.
  const [view] = useState(selectedView);
  // The parent can fall back to another view after deletion; this draft still owns its original device storage.
  const [session] = useState({ apply: onApply, reset: onReset, hasDeviceChanges });
  const [draft, setDraft] = useState(value);
  const [initial] = useState({ config: value, name: view?.name ?? '' });
  const [name, setName] = useState(view?.name ?? '');
  const [version] = useState(baseVersion ?? view?.version);
  const [newName, setNewName] = useState(view ? '' : 'All');
  const [step, setStep] = useState<'options' | 'name'>(view ? 'options' : 'name');
  const [filter, setFilter] = useState<FilterStep>();
  const views = useQuery(api.databaseViews.list, { typeId: database._id });
  const workspaceSettings = useQuery(api.workspace.settings);
  const save = useMutation(api.databaseViews.save);
  const remove = useMutation(api.databaseViews.remove);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const [deleting, setDeleting] = useState(false);
  const fields = database.fields.filter(f => !f.archived);
  const missingFields = draft.columns.some(key => !fields.some(f => f.key === key)) || draft.filters.some(filter => !fields.some(f => f.key === filter.field)) || !!(draft.sort && !['createdAt', 'updatedAt'].includes(draft.sort.field) && !fields.some(f => f.key === draft.sort?.field && sortable(f))) || !!(draft.groupBy && !fields.some(f => f.key === draft.groupBy && groupable(f)));
  const stale = view && viewIsStale(version, views?.find(v => v._id === view._id)?.version);
  const filterDirty = !!filter && JSON.stringify(filter.draft) !== JSON.stringify(filter.initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.config) || name !== initial.name || newName !== (view ? '' : 'All') || filterDirty;
  const guard = useDraftGuard({ dirty, busy: task.busy, onClose, description: 'Your unapplied view changes will be discarded.' });
  const openFilter = (index: number | 'new') => {
    const initial = draftFilter(fields[0]?.key ?? 'name', index === 'new' ? undefined : draft.filters[index]);
    if (fields.find(field => field.key === initial.field)?.kind === 'date' && initial.op === 'eq' && !initial.value) initial.value = localDateToCalendar(new Date());
    setFilter({ index, initial, draft: initial });
  };
  const backFromFilter = async () => {
    if (!filterDirty || await confirm({ title: 'Discard filter changes?', body: 'The other view options will be kept.', action: 'Discard filter', danger: true })) setFilter(undefined);
  };
  const saveShared = (create = false) => void task.run(async () => {
    if (missingFields) throw new Error('Remove unavailable fields before saving this view.');
    const id = await save({ typeId: database._id, ...draft, name: (create ? newName : name).trim(), ...(view && !create ? { viewId: view._id, version } : {}) });
    await session.apply(draft, id); guard.complete(); onClose();
  });
  return <EditorSheet title={filter ? filter.index === 'new' ? 'Add filter' : 'Edit filter' : step === 'name' ? 'New shared view' : 'View options'} onClose={() => void guard.close()} busy={task.busy} dismissible={guard.dismissible}>
    {dialog}{guard.dialog}
    {task.error && <ErrorState message={task.error} />}
    {missingFields && <Stack gap="sm"><Text>Some fields in this draft are no longer available. Remove them from these view options before applying or saving.</Text><Button label="Remove unavailable fields" variant="secondary" disabled={task.busy || !!filter} onPress={() => setDraft(normalizeViewConfig(draft, database, workspaceSettings?.currency ?? 'USD'))} />{filter && <Text tone="muted">Return to view options first to keep or discard your current filter changes.</Text>}</Stack>}
    {stale && <Text tone="danger">This shared view changed or was deleted. Reset to its shared settings before saving for everyone, or create a separate view from your changes.</Text>}
    {filter ? <>
      <Button label="Back to view options" variant="ghost" onPress={() => void backFromFilter()} />
      <FilterForm database={database} draft={filter.draft} onChange={next => setFilter({ ...filter, draft: next })} onSave={condition => {
        setDraft({ ...draft, filters: replaceFilter(draft.filters, condition, filter.index === 'new' ? undefined : filter.index) }); setFilter(undefined);
      }} />
    </> : step === 'name' ? <>
      <Button label="Back to view options" variant="ghost" disabled={task.busy} onPress={() => setStep('options')} />
      <Text tone="muted">Save these view options for everyone in your workspace.</Text>
      <Field label="Shared view name" value={newName} onChangeText={setNewName} maxLength={120} editable={!task.busy} autoFocus />
      <Button label="Create shared view" disabled={!canSave || !newName.trim() || missingFields} loading={task.busy} onPress={() => saveShared(true)} />
    </> : <>
    <ChoicePicker disabled={task.busy} label="Layout" value={draft.layout ?? 'table'} options={[{ value: 'table', label: 'List' }, { value: 'board', label: 'Board' }]} onChange={v => { if (v === 'table' || v === 'board') setDraft({ ...draft, layout: v }); }} />
    {draft.layout === 'board' && <ChoicePicker disabled={task.busy} label="Group by" value={draft.groupBy ?? ''} options={fields.filter(groupable).map(f => ({ value: f.key, label: f.label }))} onChange={v => { if (typeof v === 'string') setDraft({ ...draft, groupBy: v || undefined }); }} />}
    <ChoicePicker disabled={task.busy} allowEmpty emptyLabel="Default order" label="Sort by" value={draft.sort?.field ?? ''} options={[{ value: 'createdAt', label: 'Created' }, { value: 'updatedAt', label: 'Updated' }, ...fields.filter(sortable).map(f => ({ value: f.key, label: f.label }))]} onChange={v => { if (typeof v === 'string') setDraft({ ...draft, sort: v ? { field: v, order: draft.sort?.order ?? 'asc' } : undefined }); }} />
    {draft.sort && <ChoicePicker disabled={task.busy} label="Order" value={draft.sort.order} options={[{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]} onChange={v => { if (v === 'asc' || v === 'desc') setDraft({ ...draft, sort: { ...draft.sort!, order: v } }); }} />}
    <ChoicePicker disabled={task.busy} label="Properties shown" multiple value={draft.columns} options={fields.map(f => ({ value: f.key, label: f.label, disabled: f.key === 'name' }))} onChange={v => { if (Array.isArray(v)) setDraft({ ...draft, columns: ['name', ...v.filter(k => k !== 'name')] }); }} />
    <Text variant="label">Filters · all must match</Text>
    {draft.filters.map((filter, index) => <Stack key={index} gap="xs"><ListRow title={fields.find(f => f.key === filter.field)?.label ?? filter.field} description={Object.entries(filter).filter(([key]) => key !== 'field').map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')} disabled={task.busy} onPress={() => openFilter(index)} /><Button label="Remove filter" variant="ghost" disabled={task.busy} onPress={() => setDraft({ ...draft, filters: draft.filters.filter((_, i) => i !== index) })} /></Stack>)}
    <Button label="Add filter" variant="secondary" disabled={task.busy || draft.filters.length >= 10} onPress={() => openFilter('new')} />
    {view && <Button label="Apply on this device" disabled={missingFields} loading={task.busy} onPress={() => void task.run(async () => { if (missingFields) return; await session.apply(draft); guard.complete(); onClose(); })} />}
    {view && (session.hasDeviceChanges || stale) && <Button label="Reset to shared view" variant="ghost" disabled={task.busy} onPress={() => void task.run(async () => {
      if (await confirm({ title: 'Reset view options?', body: 'Discard your device options and use the latest shared view.', action: 'Reset options' })) { await session.reset(); guard.complete(); onClose(); }
    })} />}
    {canSave && <>
      {view && <><Field label="Shared view name" value={name} onChangeText={setName} maxLength={120} editable={!task.busy} />
        <Button label="Save for everyone" variant="secondary" disabled={!name.trim() || !!stale || missingFields} loading={task.busy} onPress={() => saveShared()} /></>}
      <Button label="New shared view" variant="secondary" disabled={task.busy} onPress={() => { task.clear(); setStep('name'); }} />
    </>}
    {view && canSave && !!views && views.length > 1 && (deleting ? <Stack><Text>Delete this shared view for everyone? Records are kept.</Text><Button label="Delete shared view" variant="danger" disabled={!!stale} loading={task.busy} onPress={() => void task.run(async () => { await remove({ viewId: view._id, version: version! }); await session.apply(initial.config, ''); guard.complete(); onClose(); })} /><Button label="Cancel deletion" variant="ghost" disabled={task.busy} onPress={() => setDeleting(false)} /></Stack> : <Button label="Delete shared view" variant="ghost" disabled={task.busy} onPress={() => setDeleting(true)} />)}
    </>}
  </EditorSheet>;
}

function FilterForm({ database, draft, onChange, onSave }: { database: Database; draft: FilterDraft; onChange: (draft: FilterDraft) => void; onSave: (filter: Condition) => void }) {
  const fields = database.fields.filter(f => !f.archived);
  const [error, setError] = useState<string>();
  const workspace = useQuery(api.workspace.settings);
  const field = fields.find(f => f.key === draft.field);
  const patch = (next: Partial<FilterDraft>) => { setError(undefined); onChange({ ...draft, ...next }); };
  const multiple = draft.op === 'in';
  const picked = multiple ? draft.values : draft.value;
  const pick = (value: string | string[]) => patch(multiple ? { values: Array.isArray(value) ? value : [value] } : { value: typeof value === 'string' ? value : value[0] ?? '' });
  const operations = [{ value: 'eq', label: 'Is' }, { value: 'empty', label: 'Is empty' }, { value: 'notEmpty', label: 'Is not empty' }, ...(field && ['choice', 'user', 'link'].includes(field.kind) ? [{ value: 'in', label: 'Is any of' }] : []), ...(field && !field.multiple && ['number', 'currency', 'date'].includes(field.kind) ? [{ value: 'range', label: 'In a range' }] : [])];
  return <>
    {error && <ErrorState message={error} />}
    <ChoicePicker label="Field" value={draft.field} options={fields.map(f => ({ value: f.key, label: f.label }))} onChange={v => { if (typeof v === 'string' && v) { setError(undefined); const next = draftFilter(v); if (fields.find(field => field.key === v)?.kind === 'date') next.value = localDateToCalendar(new Date()); onChange(next); } }} />
    <ChoicePicker label="Condition" value={draft.op} options={operations} onChange={v => { if (typeof v === 'string' && operations.some(o => o.value === v)) patch({ op: v as FilterDraft['op'], ...(v === 'eq' && field?.kind === 'date' && !draft.value ? { value: localDateToCalendar(new Date()) } : {}) }); }} />
    {field?.kind === 'date' && draft.op === 'range' ? <Stack>
      <ChoicePicker label="Start" value={draft.lower ? draft.lowerOp : 'none'} options={[{ value: 'none', label: 'No start date' }, { value: 'gte', label: 'On or after' }, { value: 'gt', label: 'After' }]} onChange={value => {
        if (value === 'none') patch({ lower: '' });
        else if (value === 'gte' || value === 'gt') patch({ lowerOp: value, lower: draft.lower || localDateToCalendar(new Date()) });
      }} />
      {!!draft.lower && <DateInput label="Start date" value={draft.lower} onChange={lower => patch({ lower })} />}
      <ChoicePicker label="End" value={draft.upper ? draft.upperOp : 'none'} options={[{ value: 'none', label: 'No end date' }, { value: 'lte', label: 'On or before' }, { value: 'lt', label: 'Before' }]} onChange={value => {
        if (value === 'none') patch({ upper: '' });
        else if (value === 'lte' || value === 'lt') patch({ upperOp: value, upper: draft.upper || localDateToCalendar(new Date()) });
      }} />
      {!!draft.upper && <DateInput label="End date" value={draft.upper} onChange={upper => patch({ upper })} />}
    </Stack> : field && draft.op === 'range' ? <Stack>
      <ChoicePicker label="Lower bound" value={draft.lowerOp} options={[{ value: 'gt', label: 'Greater than' }, { value: 'gte', label: 'At least' }]} onChange={v => { if (v === 'gt' || v === 'gte') patch({ lowerOp: v }); }} />
      <Field label="Lower value" hint="Leave empty for no lower limit." value={draft.lower} onChangeText={lower => patch({ lower })} />
      <ChoicePicker label="Upper bound" value={draft.upperOp} options={[{ value: 'lt', label: 'Less than' }, { value: 'lte', label: 'At most' }]} onChange={v => { if (v === 'lt' || v === 'lte') patch({ upperOp: v }); }} />
      <Field label="Upper value" hint="Leave empty for no upper limit." value={draft.upper} onChangeText={upper => patch({ upper })} />
    </Stack> : field && !['empty', 'notEmpty'].includes(draft.op) && (field.kind === 'date' ? <DateInput label="Date" value={draft.value} onChange={value => patch({ value })} /> : field.kind === 'choice' ? <ChoicePicker label="Value" multiple={multiple} value={picked} options={(field.options ?? []).map(o => ({ value: o.id, label: `${o.label}${o.retired ? ' (removed)' : ''}` }))} onChange={pick} /> : field.kind === 'checkbox' ? <ChoicePicker label="Value" value={draft.value} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} onChange={pick} /> : field.kind === 'user' ? <UserPicker field={{ ...field, multiple }} value={picked} onChange={pick} /> : field.kind === 'link' ? <LinkPicker field={{ ...field, multiple }} value={picked} refs={{}} onChange={pick} /> : <Field label="Value" value={draft.value} onChangeText={value => patch({ value })} hint={field.kind === 'currency' ? 'Amount, optionally prefixed by a currency code.' : undefined} />)}
    <Button label="Save filter" disabled={!field} onPress={() => { try { if (field) onSave(buildFilter(field, draft, workspace?.currency ?? 'USD')); } catch (e) { setError(errorMessage(e)); } }} />
  </>;
}
