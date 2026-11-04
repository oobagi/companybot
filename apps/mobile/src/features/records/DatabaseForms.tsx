import { useState } from 'react';
import { router } from 'expo-router';
import { fieldKinds, type FieldKind } from '@companybot/core/records';
import { can } from '@companybot/core/permissions';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { Button, ChoicePicker, ConfirmSheet, EditorSheet, ErrorState, Field, Stack, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import type { Database, TypeField } from './model';

export function DatabaseForm({ database, onClose }: { database?: Database; onClose: () => void }) {
  const [plural, setPlural] = useState(database?.plural ?? '');
  const [name, setName] = useState(database?.name ?? '');
  const [version] = useState(database?.version);
  const [baseline] = useState(() => ({ plural: database?.plural ?? '', name: database?.name ?? '' }));
  const [archive, setArchive] = useState(false);
  const types = useQuery(api.recordTypes.list);
  const create = useMutation(api.recordTypes.create);
  const update = useMutation(api.recordTypes.update);
  const move = useMutation(api.trash.move);
  const task = useTask();
  const guard = useDraftGuard({ dirty: plural !== baseline.plural || name !== baseline.name, busy: task.busy, onClose });
  const stale = database && types?.find(t => t._id === database._id)?.version !== version;
  return <EditorSheet title={database ? 'Edit database' : 'New database'} onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy}>
    {guard.dialog}
    {task.error && <ErrorState message={task.error} />}
    {stale && <Text tone="danger">This database changed. Close and reopen the editor to use its latest version.</Text>}
    <Field label="Database name" value={plural} onChangeText={setPlural} maxLength={120} placeholder="Projects" />
    {database && <Field label="One entry" value={name} onChangeText={setName} maxLength={120} placeholder="Project" />}
    <Button label={database ? 'Save' : 'Create database'} loading={task.busy} disabled={!plural.trim() || !!stale || (!!database && !name.trim())} onPress={() => void task.run(async () => {
      if (database) await update({ typeId: database._id, name: name.trim(), plural: plural.trim(), version: version! });
      else { const id = await create({ plural: plural.trim() }); router.push(`/database/${id}`); }
      onClose();
    })} />
    {database && <Button label="Archive database" variant="secondary" onPress={() => setArchive(true)} disabled={task.busy} />}
    {database && archive && <ConfirmSheet title="Archive database?" message="Its records and fields will be kept and can be restored from Archive." confirmLabel="Archive" busy={task.busy} error={task.error} onClose={() => setArchive(false)} onConfirm={() => void task.run(async () => { await move({ kind: 'database', id: database._id }); setArchive(false); onClose(); router.back(); })} />}
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
  const me = useQuery(api.workspace.me);
  const [position, setPosition] = useState<number>();
  const [archive, setArchive] = useState(false);
  const types = useQuery(api.recordTypes.list);
  const create = useMutation(api.fields.create);
  const update = useMutation(api.fields.update);
  const move = useMutation(api.trash.move);
  const task = useTask();
  const draft = JSON.stringify({ label, kind, multiple, linkType, options, optionText, position });
  const [baseline] = useState(draft);
  const guard = useDraftGuard({ dirty: draft !== baseline, busy: task.busy, onClose });
  return <EditorSheet title={field ? 'Edit field' : 'Add field'} onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy}>
    {guard.dialog}
    {task.error && <ErrorState message={task.error} />}
    <Field label="Label" value={label} onChangeText={setLabel} maxLength={60} />
    {!field && <ChoicePicker label="Type" value={kind} onChange={v => { if (typeof v === 'string' && v) setKind(v as FieldKind); }} options={fieldKinds.map(value => ({ value, label: value === 'link' ? 'Link to record' : value === 'user' ? 'Person' : value[0].toUpperCase() + value.slice(1) }))} />}
    {kind === 'choice' && <Stack gap="sm">
      {options.filter(o => !o.retired).map((option, index) => <Stack key={option.id || index} gap="xs"><Field label={`Option ${index + 1}`} value={option.label} onChangeText={text => setOptions(options.map(o => o === option ? { ...o, label: text } : o))} /><Button label={`Remove ${option.label || 'option'}`} variant="ghost" onPress={() => setOptions(options.map(o => o === option ? { ...o, retired: true } : o))} /></Stack>)}
      <Field label="New option" value={optionText} onChangeText={setOptionText} />
      <Button label="Add option" variant="secondary" disabled={!optionText.trim()} onPress={() => { setOptions([...options, { id: '', label: optionText.trim() }]); setOptionText(''); }} />
      {options.some(o => o.retired) && <Stack gap="sm"><Text tone="muted" variant="caption">Removed options stay visible on existing records. Restore an option to make it selectable again.</Text>{options.filter(o => o.retired).map((option, index) => <Button key={option.id || index} label={`Restore ${option.label}`} variant="secondary" onPress={() => setOptions(options.map(o => o === option ? { ...o, retired: false } : o))} />)}</Stack>}
    </Stack>}
    {!field && kind === 'link' && <ChoicePicker label="Linked database" options={(types ?? []).map(t => ({ value: t._id, label: t.plural }))} value={linkType} onChange={v => { if (typeof v === 'string') setLinkType(v); }} />}
    {!field && ['choice', 'user', 'link'].includes(kind) && <ChoicePicker label="Values" value={multiple ? 'many' : 'one'} onChange={v => setMultiple(v === 'many')} options={[{ value: 'one', label: 'One value' }, { value: 'many', label: 'Multiple values' }]} />}
    {field && field.key !== 'name' && me?.role && can(me.role, 'fields.manage') && <ChoicePicker label="Field position" value={String(position ?? database.fields.filter(f => !f.archived).findIndex(f => f._id === field._id))} options={database.fields.filter(f => !f.archived).slice(1).map((f, index) => ({ value: String(index + 1), label: `${index + 2} · ${f.label}` }))} onChange={value => { if (typeof value === 'string' && value) setPosition(Number(value)); }} />}
    <Button label="Save field" loading={task.busy} disabled={!label.trim() || (kind === 'link' && !linkType)} onPress={() => void task.run(async () => {
      const choices = kind === 'choice' ? options.filter(o => !o.retired).map(o => ({ ...(o.id ? { id: o.id } : {}), label: o.label.trim() })) : undefined;
      if (field) await update({ fieldId: field._id as Id<'recordFields'>, label: label.trim(), options: choices, position });
      else await create({ typeId: database._id, label: label.trim(), kind, options: choices, ...(kind === 'link' ? { linkTypeId: linkType as Id<'recordTypes'> } : {}), ...(['choice', 'user', 'link'].includes(kind) ? { multiple } : {}) });
      onClose();
    })} />
    {field && field.key !== 'name' && <Button label="Archive field" variant="secondary" onPress={() => setArchive(true)} />}
    {field && archive && <ConfirmSheet title="Archive field?" message="Stored values are kept and will return when the field is restored." confirmLabel="Archive" busy={task.busy} error={task.error} onClose={() => setArchive(false)} onConfirm={() => void task.run(async () => { await move({ kind: 'field', id: field._id }); onClose(); })} />}
  </EditorSheet>;
}
