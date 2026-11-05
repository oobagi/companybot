import { EditToolbarButton } from '@/components/navigation/EditToolbarButton';
import { useState } from 'react';
import { router } from 'expo-router';
import type { FunctionReturnType } from 'convex/server';
import { can } from '@companybot/core/permissions';
import { threadWindows } from '@companybot/core/chat';
import { isCurrencyCode } from '@companybot/core/records';
import { ImageControl } from './customize/ImageControl';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { Avatar, Button, ChoicePicker, ConfirmSheet, EditorSheet, ErrorState, Field, GroupedList, Loading, Screen, Section, Text } from '@/components/ui';

type Settings = NonNullable<FunctionReturnType<typeof api.workspace.settings>>;
const editableSettings = (value: Settings) => ({ name: value.name, currency: value.currency, memory: value.memory, imageModel: value.imageModel, routerModel: value.routerModel, threadHours: value.threadHours });

export default function General() {
  const settings = useQuery(api.workspace.settings);
  const me = useQuery(api.workspace.me);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'leave' | 'reset'>();
  const [name, setName] = useState('');
  const remove = useMutation(api.workspace.deleteWorkspace);
  const leave = useMutation(api.workspace.leave);
  const reset = useMutation(api.workspace.resetWorkspace);
  const task = useTask();
  if (!settings || !me?.access) return <Screen><Loading /></Screen>;
  const allowed = can(me.access, 'workspace.manage');
  const edit = allowed && !task.busy ? () => setEditing(true) : undefined;
  return <>
    {allowed && <EditToolbarButton label="Edit workspace" onPress={() => setEditing(true)} disabled={task.busy} />}
    <Screen nativeScroll padded={false}>
      <GroupedList sections={[
        { id: 'workspace', title: 'Workspace', rows: [
          { id: 'identity', title: settings.name, subtitle: 'Workspace', leading: <Avatar name={settings.name} image={settings.image} size="lg" />, onPress: edit, accessibilityHint: allowed ? 'Edit workspace settings' : undefined },
          { id: 'currency', title: 'Currency', value: settings.currency, onPress: edit },
          { id: 'threads', title: 'Active threads', value: threadWindows.find(w => w.hours === settings.threadHours)?.label ?? `${settings.threadHours} hours`, onPress: edit },
        ] },
        { id: 'agents', title: 'Agents', rows: [
          { id: 'memory', title: 'Memory', value: settings.memory ? 'Enabled' : 'Off', onPress: edit },
          { id: 'router', title: 'Reply decisions', value: settings.routerModels.find(m => m.id === settings.routerModel)?.name ?? settings.routerModel, onPress: edit },
        ] },
        { id: 'images', title: 'Images', rows: [
          { id: 'model', title: 'Image model', value: settings.imageModels.find(m => m.id === settings.imageModel)?.name ?? settings.imageModel, onPress: edit },
          { id: 'budget', title: 'Monthly budget', value: settings.imageBudgetUsd === 0 ? 'Image generation is off' : `$${settings.imageBudgetUsd.toLocaleString()} USD`, onPress: edit },
        ] },
        { id: 'membership', title: 'Membership', rows: [
          { id: 'leave', title: 'Leave workspace', destructive: true, disabled: task.busy, onPress: () => { task.clear(); setConfirm('leave'); } },
          ...(can(me.access, 'workspace.delete') ? [{ id: 'delete', title: 'Delete workspace', destructive: true, disabled: task.busy, onPress: () => { task.clear(); setName(''); setConfirm('delete'); } }] : []),
        ] },
        ...(can(me.access, 'workspace.reset') ? [{ id: 'reset', title: 'Start again', footer: `Erase chats, pages, records and agent configuration. Members, roles, workspace settings and billing stay.${settings.lastReset ? ` Last reset by ${settings.lastReset.by} on ${new Date(settings.lastReset.at).toLocaleDateString()}.` : ''}`, rows: [
          { id: 'reset', title: 'Reset workspace', destructive: true, disabled: task.busy, onPress: () => { task.clear(); setName(''); setConfirm('reset'); } },
        ] }] : []),
      ]} />
      {editing && <WorkspaceEditor initial={settings} onClose={() => setEditing(false)} />}
      {confirm === 'leave' && <ConfirmSheet title="Leave this workspace?" message="You will lose access to its chats, pages and records. An owner can invite you back." confirmLabel="Leave workspace" destructive busy={task.busy} error={task.error} onClose={() => setConfirm(undefined)} onConfirm={() => void task.run(async () => { await leave(); router.replace('/'); })} />}
      {confirm === 'reset' && <EditorSheet title="Reset this workspace?" busy={task.busy} onClose={() => setConfirm(undefined)}><Text>All chats, pages, records and agent configuration will be permanently erased. Members, roles, settings and billing stay. Type {settings.name} to confirm.</Text><Field label="Workspace name" value={name} onChangeText={setName} editable={!task.busy} />{task.error && <ErrorState message={task.error} />}<Button label="Reset permanently" variant="danger" loading={task.busy} disabled={name !== settings.name} onPress={() => void task.run(async () => { await reset({ name }); setConfirm(undefined); })} /></EditorSheet>}
      {confirm === 'delete' && <EditorSheet title="Delete this workspace?" busy={task.busy} onClose={() => setConfirm(undefined)}><Text>Everyone loses access and all workspace data is permanently deleted. Type {settings.name} to confirm.</Text><Field label="Workspace name" value={name} onChangeText={setName} editable={!task.busy} />{task.error && <ErrorState message={task.error} />}<Button label="Delete permanently" variant="danger" loading={task.busy} disabled={name !== settings.name} onPress={() => void task.run(async () => { await remove({ name }); router.replace('/'); })} /></EditorSheet>}
    </Screen>
  </>;
}

function WorkspaceEditor({ initial, onClose }: { initial: Settings; onClose: () => void }) {
  const [baseline] = useState(initial);
  const [draft, setDraft] = useState(() => editableSettings(initial));
  const [budget, setBudget] = useState(String(initial.imageBudgetUsd));
  const current = useQuery(api.workspace.settings);
  const update = useMutation(api.workspace.updateSettings);
  const task = useTask();
  const [pictureBusy, setPictureBusy] = useState(false);
  const busy = task.busy || pictureBusy;
  const dirty = JSON.stringify(draft) !== JSON.stringify(editableSettings(baseline)) || budget !== String(baseline.imageBudgetUsd);
  const guard = useDraftGuard({ dirty, busy, onClose });
  const conflict = !!current && current.version !== baseline.version;
  const nameError = !draft.name.trim() ? 'Enter a workspace name.' : undefined;
  const currency = draft.currency.trim().toUpperCase();
  const currencyError = !isCurrencyCode(currency) ? 'Enter a currency code such as USD or EUR.' : undefined;
  // Matches the server spending limit; do not import the agent tool runtime into mobile.
  const budgetError = !budget.trim() || !Number.isFinite(Number(budget)) || Number(budget) < 0 || Number(budget) > 10_000 ? 'Enter a monthly budget from $0 to $10,000.' : undefined;
  return <EditorSheet title="Edit workspace" onClose={() => void guard.close()} dismissible={guard.dismissible} busy={busy}>
    {guard.dialog}
    {conflict && <Text tone="danger" accessibilityRole="alert">This workspace changed elsewhere. Close and reopen the editor to review the latest settings.</Text>}
    <Section title="Workspace">
      <Field label="Name" value={draft.name} onChangeText={name => setDraft({ ...draft, name })} error={nameError} editable={!busy} />
      <Field label="Currency" value={draft.currency} onChangeText={currency => setDraft({ ...draft, currency: currency.toUpperCase() })} autoCapitalize="characters" autoCorrect={false} maxLength={3} error={currencyError} editable={!busy} hint={baseline.hasAmounts ? 'Existing amounts keep their original currency.' : 'Used for new amounts.'} />
      <ChoicePicker label="Keep active threads visible" value={String(draft.threadHours)} options={threadWindows.map(w => ({ value: String(w.hours), label: w.label }))} disabled={busy} onChange={v => { if (typeof v === 'string' && v) setDraft({ ...draft, threadHours: Number(v) }); }} />
    </Section>
    <Section title="Agents">
      <ChoicePicker label="Memory" value={String(draft.memory)} options={[{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Off — existing memories are kept' }]} disabled={busy} onChange={v => setDraft({ ...draft, memory: v === 'true' })} />
      <ChoicePicker label="Reply decision model" value={draft.routerModel} options={baseline.routerModels.map(m => ({ value: m.id, label: m.name }))} disabled={busy} onChange={v => { if (typeof v === 'string' && v) setDraft({ ...draft, routerModel: v }); }} />
    </Section>
    <Section title="Images">
      <ChoicePicker label="Model" value={draft.imageModel} options={baseline.imageModels.map(m => ({ value: m.id, label: m.name }))} disabled={busy} onChange={v => { if (typeof v === 'string' && v) setDraft({ ...draft, imageModel: v }); }} />
      <Field label="Monthly budget (USD)" value={budget} onChangeText={setBudget} keyboardType="decimal-pad" editable={!busy} error={budgetError} hint="$0 turns off image generation." />
    </Section>
    {task.error && <ErrorState message={task.error} />}
    <Button label="Save changes" loading={task.busy} disabled={pictureBusy || !dirty || conflict || !!nameError || !!currencyError || !!budgetError} onPress={() => void task.run(async () => { if (pictureBusy || nameError || currencyError || budgetError || conflict) return; await update({ ...draft, name: draft.name.trim(), currency, imageBudgetUsd: Number(budget), expectedVersion: baseline.version }); guard.complete(); onClose(); })} />
    <Section title="Workspace picture" description="Picture changes save immediately."><ImageControl of="workspace" name={baseline.name} image={current ? current.image : baseline.image} disabled={task.busy} onBusyChange={setPictureBusy} /></Section>
  </EditorSheet>;
}
