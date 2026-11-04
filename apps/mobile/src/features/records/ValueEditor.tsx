import { useState } from 'react';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { minorDigits, minorToDecimal, type FieldValue } from '@companybot/core/records';
import { Switch } from 'react-native';
import { Button, EmptyState, ErrorState, Field, ListRow, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { ChoicePicker, EditorSheet } from '@/components/ui/EditorSheet';
import { type Refs, type TypeField, valueText } from './model';
import { DateInput } from '@/components/ui/native-controls/DateInput';
import { localDateToCalendar } from '@/components/ui/native-controls/calendarDate';

export type InputValue = FieldValue | { amount: string; currency: string } | null;
export function ValueEditor({ field, value, refs, onSave }: { field: TypeField; value?: FieldValue; refs: Refs; onSave: (next: InputValue) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  return <><ListRow title={field.label} description={valueText(field, value, refs)} onPress={() => setOpen(true)} />{open && <ValueForm field={field} value={value} refs={refs} onSave={onSave} onClose={() => setOpen(false)} />}</>;
}

function ValueForm({ field, value, refs, onSave, onClose }: { field: TypeField; value?: FieldValue; refs: Refs; onSave: (next: InputValue) => Promise<unknown>; onClose: () => void }) {
  const money = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  const workspace = useQuery(api.workspace.settings);
  const [chosenCurrency, setCurrency] = useState<string>();
  const currency = chosenCurrency ?? money?.currency ?? workspace?.currency ?? '';
  const [text, setText] = useState(money ? minorToDecimal(money.minor, minorDigits(money.currency)) : typeof value === 'string' || typeof value === 'number' ? String(value) : field.kind === 'date' ? localDateToCalendar(new Date()) : '');
  const [picked, setPicked] = useState<string | string[]>(Array.isArray(value) ? value : typeof value === 'string' ? value : field.multiple ? [] : '');
  const [checked, setChecked] = useState(value === true);
  const task = useTask();
  const { colors } = useTheme();
  // The asynchronously loaded workspace currency is a default, not a user edit.
  const draft = JSON.stringify({ text, picked, checked, chosenCurrency });
  const [baseline] = useState(draft);
  const guard = useDraftGuard({ dirty: draft !== baseline, busy: task.busy, onClose });
  return <EditorSheet title={field.label} onClose={() => void guard.close()} dismissible={guard.dismissible} busy={task.busy}>
    {guard.dialog}
    {task.error && <ErrorState message={task.error} />}
    {field.kind === 'checkbox' ? <Stack horizontal><Text style={{ flex: 1 }}>{field.label}</Text><Switch accessibilityLabel={field.label} value={checked} onValueChange={setChecked} disabled={task.busy} trackColor={{ true: colors.primary }} /></Stack>
      : field.kind === 'date' ? <DateInput label={field.label} value={text} onChange={setText} disabled={task.busy} />
      : field.kind === 'choice' ? <ChoicePicker label="Value" options={(field.options ?? []).map(o => ({ value: o.id, label: `${o.label}${o.retired ? ' (removed)' : ''}`, disabled: o.retired }))} value={picked} onChange={setPicked} multiple={field.multiple} allowEmpty disabled={task.busy} />
      : field.kind === 'user' ? <UserPicker field={field} value={picked} onChange={setPicked} />
      : field.kind === 'link' ? <LinkPicker field={field} value={picked} refs={refs} onChange={setPicked} />
      : <Field label={field.kind === 'currency' ? 'Amount' : field.label} value={text} onChangeText={setText} editable={!task.busy} autoCapitalize={['email', 'url'].includes(field.kind) ? 'none' : 'sentences'} autoCorrect={!['email', 'url', 'date', 'number', 'currency'].includes(field.kind)} keyboardType={field.kind === 'email' ? 'email-address' : field.kind === 'phone' ? 'phone-pad' : ['number', 'currency'].includes(field.kind) ? 'numbers-and-punctuation' : field.kind === 'url' ? 'url' : 'default'} multiline={field.kind === 'text' && field.key !== 'name'} />}
    {field.kind === 'currency' && <Field label="Currency" value={currency} onChangeText={v => setCurrency(v.toUpperCase())} autoCapitalize="characters" maxLength={3} hint="ISO currency code, such as USD, EUR or JPY." />}
    <Button label="Save" loading={task.busy} disabled={field.kind === 'currency' && !currency} onPress={() => void task.run(async () => {
      const next = field.kind === 'checkbox' ? checked : ['choice', 'user', 'link'].includes(field.kind) ? (Array.isArray(picked) ? picked.length ? picked : null : picked || null) : field.kind === 'currency' ? text.trim() ? { amount: text.trim(), currency } : null : text.trim() || null;
      await onSave(next); onClose();
    })} />
    {field.key !== 'name' && <Button label="Clear value" variant="ghost" disabled={task.busy} onPress={() => void task.run(async () => { await onSave(null); onClose(); })} />}
  </EditorSheet>;
}

export function UserPicker({ field, value, onChange }: { field: TypeField; value: string | string[]; onChange: (v: string | string[]) => void }) {
  const team = useQuery(api.workspace.team);
  return <ChoicePicker label="Person" value={value} onChange={onChange} multiple={field.multiple} allowEmpty options={(team?.members ?? []).map(m => ({ value: m.userId, label: m.name }))} />;
}

export function LinkPicker({ field, value, refs, onChange }: { field: TypeField; value: string | string[]; refs: Refs; onChange: (v: string | string[]) => void }) {
  const [search, setSearch] = useState('');
  const types = useQuery(api.recordTypes.list);
  const type = types?.find(t => t._id === field.linkType || t.key === field.linkType);
  const rows = useQuery(api.records.search, type && search.trim() ? { typeId: type._id as Id<'recordTypes'>, query: search.trim() } : 'skip');
  const selected = (Array.isArray(value) ? value : [value]).filter(Boolean);
  return <Stack><Field label="Search records" value={search} onChangeText={setSearch} />
    {selected.map(id => <ListRow key={id} title={refs[id]?.name ?? rows?.find(r => r._id === id)?.title ?? 'Selected record'} description="Tap to remove" onPress={() => onChange(field.multiple ? selected.filter(v => v !== id) : '')} />)}
    {rows?.map(row => <ListRow key={row._id} title={row.title} selected={selected.includes(row._id)} onPress={() => { onChange(field.multiple ? selected.includes(row._id) ? selected.filter(v => v !== row._id) : [...selected, row._id] : row._id); }} />)}
    {!!search.trim() && rows?.length === 0 && <EmptyState layout="inline" title="No matching records" />}
  </Stack>;
}
