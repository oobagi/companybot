import { useState } from 'react';
import { router } from 'expo-router';
import { fieldKinds, type FieldKind } from '@companybot/core/records';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { Button, ChoicePicker, EditorSheet, ErrorState, Field, Stack, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import type { Database, TypeField } from './model';
import { choiceOptionsForSave } from './choiceOptions';

export function DatabaseForm({ database, onClose }: { database?: Database; onClose: () => void }) {
  const [plural, setPlural] = useState(database?.plural ?? '');
  const [name, setName] = useState(database?.name ?? '');
  const [version] = useState(database?.version);
  const [baseline] = useState(() => ({ plural: database?.plural ?? '', name: database?.name ?? '' }));
  const confirmation = useConfirm();
  const types = useQuery(api.recordTypes.list);
  const create = useMutation(api.recordTypes.create);
  const update = useMutation(api.recordTypes.update);
  const move = useMutation(api.trash.move);
  const task = useTask();
  const guard = useDraftGuard({ dirty: plural !== baseline.plural || name !== baseline.name, busy: task.busy, onClose });
  const stale = database && types !== undefined && types.find(t => t._id === database._id)?.version !== version;
  const submit = () => void task.run(async () => {
    let created: Id<'recordTypes'> | undefined;
    if (database) await update({ typeId: database._id, name: name.trim(), plural: plural.trim(), version: version! });
    else created = await create({ plural: plural.trim() });
    guard.complete();
    onClose();
    if (created) router.push(`/database/${created}`);
  });
  return <EditorSheet title={database ? 'Edit database' : 'New database'} size="content" onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy} submit={{ label: database ? 'Done' : 'Create', disabled: !plural.trim() || !!stale || (!!database && (!name.trim() || types === undefined)), onPress: submit }}>
    {guard.dialog}{confirmation.dialog}
    {task.error && <ErrorState message={task.error} />}
    {stale && <Text tone="danger">This database changed. Close and reopen the editor to use its latest version.</Text>}
    <Field label="Database name" value={plural} onChangeText={setPlural} editable={!task.busy} maxLength={120} placeholder="Projects" />
    {database && <Field label="One entry" value={name} onChangeText={setName} editable={!task.busy} maxLength={120} placeholder="Project" />}
    {database && <Button label="Archive database" variant="secondary" disabled={task.busy} onPress={() => void task.run(async () => {
      if (!await confirmation.confirm({ title: 'Archive database?', body: 'Its records and fields will be kept and can be restored from Archive. Unsaved database changes will be discarded.', action: 'Archive', danger: true })) return;
      await move({ kind: 'database', id: database._id });
      guard.complete();
      onClose();
      if (router.canGoBack()) router.back(); else router.replace('/databases');
    })} />}
  </EditorSheet>;
}

export function FieldForm({ database, field, onClose }: { database: Database; field?: TypeField; onClose: () => void }) {
  const [label, setLabel] = useState(field?.label ?? '');
  const [kind, setKind] = useState<FieldKind>(field?.kind ?? 'text');
  const [multiple, setMultiple] = useState(field?.multiple ?? false);
  const [linkType, setLinkType] = useState(field?.linkType ?? '');
  // Stable ids preserve existing values when labels change. Retired options remain until explicitly revived.
  const [options, setOptions] = useState(field?.options?.map(o => ({ ...o })) ?? []);
  const [optionText, setOptionText] = useState('');
  const [position, setPosition] = useState<number>();
  const confirmation = useConfirm();
  const types = useQuery(api.recordTypes.list);
  const create = useMutation(api.fields.create);
  const update = useMutation(api.fields.update);
  const move = useMutation(api.trash.move);
  const task = useTask();
  const draft = JSON.stringify({ label, kind, multiple, linkType, options, optionText, position });
  const [baseline, setBaseline] = useState(draft);
  const [schema, setSchema] = useState(() => field && fieldSchema(field));
  const liveDatabase = types?.find(item => item._id === database._id);
  const liveField = field && liveDatabase?.fields.find(item => item._id === field._id);
  const stale = !!field && types !== undefined && (!liveField || liveField.archived || fieldSchema(liveField) !== schema);
  const allowed = !!liveDatabase?.canManage && (!field || !!liveField?.canEdit);
  const converting = !!liveField?.changing;
  const unavailable = types === undefined || !allowed || stale || converting;
  const disabled = task.busy || unavailable;
  const guard = useDraftGuard({ dirty: draft !== baseline, busy: task.busy, onClose });
  const submit = () => void task.run(async () => {
    if (unavailable || !label.trim() || (kind === 'link' && !linkType)) return;
    const choices = kind === 'choice' ? choiceOptionsForSave(label, options, optionText) : undefined;
    if (field) await update({ fieldId: field._id as Id<'recordFields'>, label: label.trim(), options: choices, position });
    else await create({ typeId: database._id, label: label.trim(), kind, options: choices, ...(kind === 'link' ? { linkTypeId: linkType as Id<'recordTypes'> } : {}), ...(['choice', 'user', 'link'].includes(kind) ? { multiple } : {}) });
    guard.complete(); onClose();
  });
  const reload = () => {
    if (!liveField || liveField.archived || task.busy) return;
    const latest = { label: liveField.label, kind: liveField.kind, multiple: liveField.multiple ?? false, linkType: ('linkType' in liveField ? liveField.linkType : undefined) ?? '', options: liveField.options?.map(option => ({ ...option })) ?? [], optionText: '', position: undefined };
    setLabel(latest.label); setKind(latest.kind); setMultiple(latest.multiple); setLinkType(latest.linkType); setOptions(latest.options); setOptionText(''); setPosition(undefined);
    setBaseline(JSON.stringify(latest)); setSchema(fieldSchema(liveField)); task.clear();
  };
  return <EditorSheet title={field ? 'Edit field' : 'Add field'} onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy} submit={{ label: field ? 'Done' : 'Add', disabled: unavailable || !label.trim() || (kind === 'link' && !linkType), onPress: submit }}>
    {guard.dialog}{confirmation.dialog}
    {task.error && <ErrorState message={task.error} />}
    {stale && <ErrorState message={liveField && !liveField.archived ? 'This field changed while you were editing. Reload its current settings before saving.' : 'This field is no longer available. Your draft has been kept.'} />}
    {stale && liveField && !liveField.archived && <Button label="Reload latest" variant="secondary" disabled={task.busy || converting || !allowed} onPress={reload} />}
    {types !== undefined && !allowed && <Text tone="muted">You can no longer manage this field. Your draft has been kept.</Text>}
    {converting && <Text tone="muted">This field is converting its values. Editing will be available when it finishes.</Text>}
    <Field label="Label" value={label} onChangeText={setLabel} editable={!disabled} maxLength={60} />
    {!field && <ChoicePicker label="Type" disabled={disabled} value={kind} onChange={v => { if (typeof v === 'string' && v) setKind(v as FieldKind); }} options={fieldKinds.map(value => ({ value, label: value === 'link' ? 'Link to record' : value === 'user' ? 'Person' : value[0].toUpperCase() + value.slice(1) }))} />}
    {kind === 'choice' && <Stack gap="sm">
      {options.filter(o => !o.retired).map((option, index) => <Stack key={option.id || index} gap="xs"><Field label={`Option ${index + 1}`} value={option.label} editable={!disabled} onChangeText={text => setOptions(options.map(o => o === option ? { ...o, label: text } : o))} /><Button label={`Remove ${option.label || 'option'}`} variant="ghost" disabled={disabled} onPress={() => setOptions(options.map(o => o === option ? { ...o, retired: true } : o))} /></Stack>)}
      <Field label="New option" value={optionText} onChangeText={setOptionText} editable={!disabled} />
      <Button label="Add option" variant="secondary" disabled={!optionText.trim() || disabled} onPress={() => { setOptions([...options, { id: '', label: optionText.trim() }]); setOptionText(''); }} />
      {options.some(o => o.retired) && <Stack gap="sm"><Text tone="muted" variant="caption">Removed options stay visible on existing records. Restore an option to make it selectable again.</Text>{options.filter(o => o.retired).map((option, index) => <Button key={option.id || index} label={`Restore ${option.label}`} variant="secondary" disabled={disabled} onPress={() => setOptions(options.map(o => o === option ? { ...o, retired: false } : o))} />)}</Stack>}
    </Stack>}
    {!field && kind === 'link' && <ChoicePicker label="Linked database" disabled={disabled} options={(types ?? []).map(t => ({ value: t._id, label: t.plural }))} value={linkType} onChange={v => { if (typeof v === 'string') setLinkType(v); }} />}
    {!field && ['choice', 'user', 'link'].includes(kind) && <ChoicePicker label="Values" disabled={disabled} value={multiple ? 'many' : 'one'} onChange={v => setMultiple(v === 'many')} options={[{ value: 'one', label: 'One value' }, { value: 'many', label: 'Multiple values' }]} />}
    {field && field.key !== 'name' && database.canManage && <ChoicePicker label="Field position" disabled={disabled} value={String(position ?? database.fields.filter(f => !f.archived).findIndex(f => f._id === field._id))} options={database.fields.filter(f => !f.archived).slice(1).map((f, index) => ({ value: String(index + 1), label: `${index + 2} · ${f.label}` }))} onChange={value => { if (typeof value === 'string' && value) setPosition(Number(value)); }} />}
    {field && field.key !== 'name' && <Button label="Archive field" variant="secondary" disabled={disabled} onPress={() => void task.run(async () => {
      if (unavailable) return;
      if (!await confirmation.confirm({ title: 'Archive field?', body: 'Stored values are kept and will return when the field is restored. Unsaved field changes will be discarded.', action: 'Archive', danger: true })) return;
      await move({ kind: 'field', id: field._id }); guard.complete(); onClose();
    })} />}
  </EditorSheet>;
}

/** Fields have no mutation version; block full-option saves after an observed schema change. */
function fieldSchema(field: TypeField) {
  return JSON.stringify({ label: field.label, kind: field.kind, multiple: !!field.multiple, linkType: field.linkType ?? '', options: field.options ?? [] });
}
