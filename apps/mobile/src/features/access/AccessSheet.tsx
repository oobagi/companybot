import { useState } from 'react';
import { EVERYONE, type AccessEntry } from '@companybot/core/place-access';
import { Button, ChoicePicker, EditorSheet, ErrorState, ListRow, Loading, Stack, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';

export function AccessSheet({ access, onSave, onClose, editLabel = 'Edit', following, requireEveryone = false, description }: {
  access: AccessEntry[]; onSave?: (entries: AccessEntry[] | null) => Promise<unknown>; onClose: () => void;
  editLabel?: 'Edit' | 'Post'; following?: boolean; requireEveryone?: boolean; description?: string;
}) {
  const roles = useQuery(api.roles.list);
  const [draft, setDraft] = useState(access);
  const [inherit, setInherit] = useState(following ?? false);
  const [baseline, setBaseline] = useState(() => JSON.stringify({ access, following }));
  const current = JSON.stringify({ access, following });
  const stale = baseline !== current;
  const dirty = JSON.stringify({ access: draft, following: following === undefined ? undefined : inherit }) !== baseline;
  const task = useTask();
  const guard = useDraftGuard({ dirty: !!onSave && dirty, busy: task.busy, onClose, description: 'Your unsaved access changes will be discarded.' });
  const nameOf = (id: string) => id === EVERYONE ? 'Everyone' : roles?.find(role => role.id === id)?.name ?? 'Deleted role';
  const addable = [{ id: EVERYONE, name: 'Everyone' }, ...(roles ?? []).filter(role => role.builtIn !== 'owner')].filter(role => !draft.some(entry => entry.role === role.id));
  const editable = !!onSave && !task.busy && !stale && !inherit;
  const pendingInheritance = inherit && following === false;
  const canSave = !!onSave && roles !== undefined && dirty && !stale;
  const save = () => { if (canSave && onSave) void task.run(async () => { await onSave(inherit ? null : draft); guard.complete(); onClose(); }); };
  return <EditorSheet title="Who can access" onClose={() => void guard.close()} busy={task.busy} dismissible={guard.dismissible} submit={onSave ? { disabled: !canSave, onPress: save } : undefined}>
    {guard.dialog}
    {description && <Text tone="muted">{description}</Text>}
    {task.error && <ErrorState message={task.error} />}
    {stale && <Stack><Text tone="muted">Access changed while this sheet was open. Reload before saving.</Text><Button label="Reload access" variant="secondary" disabled={task.busy} onPress={() => { setDraft(access); setInherit(following ?? false); setBaseline(current); }} /></Stack>}
    {following !== undefined && <ChoicePicker label="Access list" value={inherit ? 'parent' : 'own'} disabled={!onSave || task.busy || stale} options={[{ value: 'parent', label: 'Same as parent page' }, { value: 'own', label: 'Its own list' }]} onChange={value => setInherit(value === 'parent')} />}
    {roles === undefined ? <Loading /> : <>
      {pendingInheritance ? <Text tone="muted">After saving, this page will use its parent page’s current access list.</Text> : draft.map(entry => <ChoicePicker key={entry.role} label={nameOf(entry.role)} value={entry.level} disabled={!editable} options={[{ value: 'view', label: 'View' }, { value: 'edit', label: editLabel }, ...(!requireEveryone || entry.role !== EVERYONE ? [{ value: 'remove', label: 'Remove access' }] : [])]} onChange={value => setDraft(previous => value === 'remove' ? previous.filter(item => item.role !== entry.role) : previous.map(item => item.role === entry.role && (value === 'view' || value === 'edit') ? { ...item, level: value } : item))} />)}
      <ListRow title="Owners" description={`Always ${editLabel.toLowerCase()}`} />
      {!pendingInheritance && !draft.length && <Text tone="muted">Only owners can see it.</Text>}
      {editable && addable.length > 0 && <ChoicePicker label="Add a role" value="" allowEmpty emptyLabel="Choose a role" options={addable.map(role => ({ value: role.id, label: role.name }))} onChange={value => { if (typeof value === 'string' && value && addable.some(role => role.id === value)) setDraft(previous => [...previous, { role: value, level: 'view' }]); }} />}
    </>}
  </EditorSheet>;
}
