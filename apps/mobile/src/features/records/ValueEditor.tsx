import { useState } from 'react';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { minorDigits, minorToDecimal, type FieldValue } from '@companybot/core/records';
import { Button, EmptyState, ErrorState, Field, ListRow, Stack, SettingsRow, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { ChoicePicker, EditorSheet } from '@/components/ui/EditorSheet';
import { type Refs, type TypeField } from './model';
import { DateInput } from '@/components/ui/native-controls/DateInput';
import { localDateToCalendar } from '@/components/ui/native-controls/calendarDate';

export type InputValue = FieldValue | { amount: string; currency: string } | null;
const fieldShape = (field: TypeField) => JSON.stringify({ kind: field.kind, multiple: field.multiple, linkType: 'linkType' in field ? field.linkType : undefined, options: field.options });
export function ValueForm({ field: liveField, value, refs, disabledReason, onSave, onClose }: { field: TypeField; value?: FieldValue; refs: Refs; disabledReason?: string; onSave: (next: InputValue) => Promise<unknown>; onClose: () => void }) {
  const [field] = useState(liveField);
  const [cleared, setCleared] = useState(false);
  const schemaChanged = fieldShape(field) !== fieldShape(liveField);
  // A remote update must not silently pair an old amount draft with a new currency.
  const [initialValue] = useState(value);
  const money = initialValue && typeof initialValue === 'object' && !Array.isArray(initialValue) ? initialValue : undefined;
  const conflict = JSON.stringify(value) !== JSON.stringify(initialValue);
  const workspace = useQuery(api.workspace.settings);
  const [chosenCurrency, setCurrency] = useState<string>();
  const currency = chosenCurrency ?? money?.currency ?? workspace?.currency ?? '';
  const [text, setText] = useState(money ? minorToDecimal(money.minor, minorDigits(money.currency)) : typeof value === 'string' || typeof value === 'number' ? String(value) : field.kind === 'date' ? localDateToCalendar(new Date()) : '');
  const [picked, setPicked] = useState<string | string[]>(Array.isArray(value) ? value : typeof value === 'string' ? value : field.multiple ? [] : '');
  const [checked, setChecked] = useState(value === true);
  const task = useTask();
  const unavailable = task.busy || !!disabledReason || conflict || schemaChanged;
  // The asynchronously loaded workspace currency is a default, not a user edit.
  const draft = JSON.stringify({ text, picked, checked, chosenCurrency, cleared });
  const [baseline] = useState(draft);
  const guard = useDraftGuard({ dirty: draft !== baseline, busy: task.busy, onClose });
  const submit = () => { if (!unavailable) void task.run(async () => {
    const next = cleared ? null : field.kind === 'checkbox' ? checked : ['choice', 'user', 'link'].includes(field.kind) ? (Array.isArray(picked) ? picked.length ? picked : null : picked || null) : field.kind === 'currency' ? text.trim() ? { amount: text.trim(), currency } : null : text.trim() || null;
    await onSave(next); guard.complete(); onClose();
  }); };
  return <EditorSheet title={field.label} size={['text', 'user', 'link'].includes(field.kind) ? 'large' : 'content'} onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy} submit={{ disabled: unavailable || (!cleared && field.kind === 'currency' && !currency), onPress: submit }}>
    {guard.dialog}
    {disabledReason && <ErrorState message={disabledReason} />}
    {schemaChanged && <ErrorState message="This field changed elsewhere. Your draft is kept here; close and reopen to review the new field before saving." />}
    {conflict && <Text tone="danger" accessibilityRole="alert">This value changed elsewhere. Close and reopen the editor to review it before saving.</Text>}
    {task.error && <ErrorState message={task.error} />}
    {cleared ? <Text>Tap Done to clear this value, or Cancel to keep it.</Text> : <>
    {field.kind === 'checkbox' ? <SettingsRow row={{ id: field.key, title: field.label, kind: 'toggle', value: checked, onValueChange: setChecked, disabled: unavailable }} />
      : field.kind === 'date' ? <DateInput label={field.label} value={text} onChange={setText} disabled={unavailable} />
      : field.kind === 'choice' ? <ChoicePicker label="Value" options={(field.options ?? []).map(o => ({ value: o.id, label: `${o.label}${o.retired ? ' (removed)' : ''}`, disabled: o.retired }))} value={picked} onChange={setPicked} multiple={field.multiple} allowEmpty disabled={unavailable} />
      : field.kind === 'user' ? <UserPicker field={field} value={picked} onChange={setPicked} disabled={unavailable} />
      : field.kind === 'link' ? <LinkPicker field={field} value={picked} refs={refs} onChange={setPicked} disabled={unavailable} />
      : <Field label={field.kind === 'currency' ? 'Amount' : field.label} value={text} onChangeText={setText} editable={!unavailable} autoCapitalize={['email', 'url'].includes(field.kind) ? 'none' : 'sentences'} autoCorrect={!['email', 'url', 'date', 'number', 'currency'].includes(field.kind)} keyboardType={field.kind === 'email' ? 'email-address' : field.kind === 'phone' ? 'phone-pad' : ['number', 'currency'].includes(field.kind) ? 'numbers-and-punctuation' : field.kind === 'url' ? 'url' : 'default'} multiline={field.kind === 'text' && field.key !== 'name'} />}
    {field.kind === 'currency' && <Field label="Currency" value={currency} onChangeText={v => setCurrency(v.toUpperCase())} autoCapitalize="characters" maxLength={3} editable={!unavailable} hint="ISO currency code, such as USD, EUR or JPY." />}
    </>}
    {field.key !== 'name' && <Button label={cleared ? 'Undo clear' : 'Clear value'} variant="ghost" disabled={unavailable} onPress={() => setCleared(value => !value)} />}

  </EditorSheet>;
}

export function UserPicker({ field, value, onChange, disabled }: { field: TypeField; value: string | string[]; onChange: (v: string | string[]) => void; disabled?: boolean }) {
  const team = useQuery(api.workspace.team);
  return <ChoicePicker label="Person" disabled={disabled} value={value} onChange={onChange} multiple={field.multiple} allowEmpty options={(team?.members ?? []).map(m => ({ value: m.userId, label: m.name }))} />;
}

export function LinkPicker({ field, value, refs, onChange, disabled }: { field: TypeField; value: string | string[]; refs: Refs; onChange: (v: string | string[]) => void; disabled?: boolean }) {
  const [search, setSearch] = useState('');
  const types = useQuery(api.recordTypes.list);
  const type = types?.find(t => t._id === field.linkType || t.key === field.linkType);
  const rows = useQuery(api.records.search, type && search.trim() ? { typeId: type._id as Id<'recordTypes'>, query: search.trim() } : 'skip');
  const selected = (Array.isArray(value) ? value : [value]).filter(Boolean);
  const selectedRefs = useQuery(api.records.refs, selected.length ? { ids: selected.slice(0, 200) } : 'skip');
  return <Stack><Field label="Search records" editable={!disabled} value={search} onChangeText={setSearch} />
    {selected.map(id => <ListRow key={id} disabled={disabled} title={selectedRefs?.[id]?.locked || refs[id]?.locked ? 'Locked record' : selectedRefs?.[id]?.name ?? refs[id]?.name ?? rows?.find(r => r._id === id)?.title ?? 'Selected record'} description="Tap to remove" onPress={() => onChange(field.multiple ? selected.filter(v => v !== id) : '')} />)}
    {rows?.map(row => <ListRow key={row._id} disabled={disabled} title={row.title} selected={selected.includes(row._id)} onPress={() => { onChange(field.multiple ? selected.includes(row._id) ? selected.filter(v => v !== row._id) : [...selected, row._id] : row._id); }} />)}
    {!!search.trim() && rows?.length === 0 && <EmptyState layout="inline" title="No matching records" />}
  </Stack>;
}
