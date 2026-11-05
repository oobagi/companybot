import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { can } from '@companybot/core/permissions';
import { customAutomationError, scheduleCron, type CustomAutomationConfig, type AutomationAudience } from '@companybot/core/automations';
import { DEFAULT_CRON } from '@companybot/core/schedules';
import type { FunctionReturnType } from 'convex/server';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { router, Stack as RouterStack, useLocalSearchParams } from 'expo-router';
import { Badge, Button, Card, ChoicePicker, EditorSheet, EmptyState, ErrorState, Field, GroupedList, ListRow, Loading, Screen, ScreenList, Stack, Text, Divider, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { PendingWakeups } from './customize/PendingWakeups';
import { ScheduleEditor } from './customize/ScheduleEditor';
import { NavigationHeader } from '@/components/navigation/NavigationHeader';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import { useTheme } from '@/design';

type Automation = FunctionReturnType<typeof api.automations.list>[number];
type Channel = { _id: Id<'chats'>; title: string };
const cleanConfig = (a?: Automation): CustomAutomationConfig => a?.custom ? { name: a.custom.name, prompt: a.custom.prompt, trigger: a.custom.trigger.type === 'schedule' ? { type: 'schedule', cron: scheduleCron(a.custom.trigger) } : a.custom.trigger } : { name: '', prompt: '', trigger: { type: 'schedule', cron: DEFAULT_CRON } };
const consent = { body: 'It runs as you. When it needs permission to do something, like post or read your DMs, it asks in your DM with the agent. You can allow that action for later runs there.', action: 'Turn on' };

export default function Automations() {
  const items = useQuery(api.automations.list);
  const me = useQuery(api.workspace.me);
  const wakeups = useQuery(api.wakeups.list, {});
  const { itemId } = useLocalSearchParams<{ itemId?: string }>();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const task = useTask();
  const { spacing } = useTheme();
  const item = items?.find(a => a.id === itemId);
  if (itemId) return !items ? <Screen><Loading /></Screen> : item ? <AutomationDetail key={item.id} automation={item} /> : <Screen><EmptyState title="Automation unavailable" description="It may have been removed or you may no longer have access." /></Screen>;
  const query = search.trim().toLocaleLowerCase();
  const active = items?.filter(a => !a.trash && (!query || `${a.name} ${a.trigger} ${a.agentName ?? ''}`.toLocaleLowerCase().includes(query)));
  return <>
    <NavigationHeader search={{ placeholder: 'Search automations', value: search, onChange: setSearch }} action={me?.access ? { label: 'New automation', disabled: task.busy, onPress: () => { task.clear(); setCreating(true); } } : undefined} />
    <Screen nativeScroll padded={false}><ScreenList data={active ?? []} keyExtractor={a => a.id} ItemSeparatorComponent={Divider}
      renderItem={({ item: a }) => <ListRow title={a.name} description={`${a.trigger} · ${a.agentName ?? 'No agent'}`} trailing={<Badge label={a.enabled ? 'Running' : 'Paused'} tone={a.enabled ? 'success' : 'default'} />} onPress={() => router.push({ pathname: '/settings/[section]', params: { section: 'automations', itemId: a.id } })} />}
      ListEmptyComponent={!items ? <Loading /> : <EmptyState layout={wakeups?.length ? 'inline' : 'screen'} title={query ? 'No matching automations' : 'No automations yet'} description={query ? 'Try another name, schedule or agent.' : 'Have an agent handle routine work on a schedule or event.'} />}
      ListFooterComponent={wakeups?.length ? <Stack style={{ padding: spacing.lg }}><PendingWakeups /></Stack> : undefined} />
    </Screen>
    {creating && <AutomationEditor task={task} onClose={() => setCreating(false)} />}
  </>;
}

type DetailMode = 'configuration' | 'agent' | 'audience' | 'webhook' | 'prompt';
function AutomationDetail({ automation: a }: { automation: Automation }) {
  const [mode, setMode] = useState<DetailMode>();
  const [notice, setNotice] = useState<string>();
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const update = useMutation(api.automations.update);
  const subscribe = useMutation(api.automations.subscribe);
  const runNow = useMutation(api.automationRuns.runNow);
  const remove = useMutation(api.automations.remove);
  const guard = useDraftGuard({ dirty: false, busy: task.busy, onClose: () => {} });
  const editable = a.canEdit && !a.trash;
  const askEnable = () => confirm({ title: `Turn on ${a.name}?`, ...consent });
  const open = (next: DetailMode) => { if (!task.busy) { task.clear(); setNotice(undefined); setMode(next); } };
  const actions = [
    ...(editable && a.custom ? [{ id: 'edit', title: 'Edit configuration', icon: 'pencil' as const }] : []),
    ...(editable ? [{ id: 'pause', title: a.enabled ? 'Pause automation' : 'Resume automation' }, { id: 'run', title: 'Run now' }, { id: 'archive', title: 'Archive automation', destructive: true }] : []),
  ].map(action => ({ ...action, disabled: task.busy || !!mode }));
  return <>
    <RouterStack.Screen options={{ title: a.name }} />
    {actions.length > 0 && <HeaderMenu label="Automation actions" actions={actions} onAction={id => {
      if (!editable || task.busy || mode) return;
      if (id === 'edit' && a.custom) open('configuration');
      else void task.run(async () => {
        if (id === 'pause') { if (!a.enabled && !await askEnable()) return; await update({ automationId: a.id, enabled: !a.enabled }); }
        if (id === 'run') { await runNow({ automationId: a.id }); setNotice(`Started. Check your chat with ${a.agentName ?? 'the agent'}.`); }
        if (id === 'archive') { if (!await confirm({ title: `Archive ${a.name}?`, body: 'It stops running. Its configuration and permissions remain in Archive.', action: 'Archive', danger: true })) return; await remove({ automationId: a.id }); guard.complete(); router.back(); }
      });
    }} />}
    <Screen nativeScroll padded={false}>{dialog}{guard.dialog}
      <GroupedList sections={[
        ...(task.error && !mode ? [{ id: 'error', rows: [{ id: 'error', title: 'Could not complete the action', subtitle: task.error }] }] : []),
        ...(notice ? [{ id: 'notice', rows: [{ id: 'notice', title: notice }] }] : []),
        { id: 'summary', rows: [
          { id: 'status', title: 'Status', value: a.trash ? 'Archived' : a.enabled ? 'Running' : 'Paused' },
          { id: 'when', title: 'When', subtitle: a.trigger, onPress: editable && a.custom ? () => open('configuration') : undefined, disabled: task.busy },
          { id: 'agent', title: 'Agent', value: `${a.agentName ?? 'No agent'}${a.agentArchived ? ' (archived)' : ''}`, onPress: editable ? () => open('agent') : undefined, disabled: task.busy },
          { id: 'audience', title: 'Runs for', value: a.runsFor ?? 'Subscribers', onPress: editable ? () => open('audience') : undefined, disabled: task.busy },
          { id: 'prompt', title: 'Prompt', value: 'Read prompt', onPress: () => open('prompt'), disabled: task.busy },
        ] },
        ...(a.description || a.details ? [{ id: 'about', title: 'About', rows: [{ id: 'description', title: a.description || a.name, subtitle: a.details || undefined }] }] : []),
        ...(!a.trash && a.audience === 'subscribers' ? [{ id: 'subscription', footer: consent.body, rows: [{ id: 'subscribed', kind: 'toggle' as const, title: 'Run for me', value: a.subscribed, disabled: task.busy, onValueChange: (on: boolean) => void task.run(async () => { if (on && !await askEnable()) return; await subscribe({ automationId: a.id, on }); }) }] }] : []),
        ...(a.webhookUrl && !a.trash ? [{ id: 'webhook', rows: [{ id: 'webhook', title: 'Webhook URL', value: 'View and copy', onPress: () => open('webhook'), disabled: task.busy }] }] : []),
        { id: 'activity', title: 'Activity', footer: editable ? `Run now sends one run just to you${a.scheduled ? '.' : ', using sample event data.'}` : undefined, rows: [{ id: 'last-run', title: a.lastRunAt ? `Last ran ${new Date(a.lastRunAt).toLocaleString()}` : 'Has not run yet', subtitle: a.lastResult ?? undefined }] },
      ]} />
    </Screen>
    {mode === 'configuration' && editable && a.custom && <AutomationEditor automation={a} task={task} onClose={() => setMode(undefined)} />}
    {mode && mode !== 'configuration' && <AutomationSettingSheet automation={a} mode={mode} task={task} onClose={() => setMode(undefined)} />}
  </>;
}
function AutomationEditor({ automation: a, task, onClose }: { automation?: Automation; task: ReturnType<typeof useTask>; onClose: () => void }) {
  const me = useQuery(api.workspace.me);
  const teamAllowed = !!me?.access && can(me.access, 'automations.edit');
  const [baseline, setBaseline] = useState(() => cleanConfig(a));
  const [config, setConfig] = useState(baseline);
  const [base, setBase] = useState(a?.custom?.version);
  const [agentId, setAgentId] = useState('');
  const [audience, setAudience] = useState<AutomationAudience>('creator');
  const [channelId, setChannelId] = useState<Id<'chats'>>();
  const [initialTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [timeZone, setTimeZone] = useState(initialTimeZone);
  const agents = useQuery(api.agents.list)?.filter((agent) => !agent.archived);
  const channels = useQuery(api.chats.list)?.channels ?? [];
  const create = useMutation(api.automations.create); const save = useMutation(api.automations.save);
  const editable = !a || (a.canEdit && !!a.custom && !a.trash);
  const conflict = !!a?.custom && a.custom.version !== base;
  const dirty = (!a && (agentId !== '' || audience !== 'creator' || !!channelId || timeZone !== initialTimeZone)) || JSON.stringify(config) !== JSON.stringify(baseline);
  const selectedAgent = agentId || agents?.[0]?._id;
  const guard = useDraftGuard({ dirty: editable && dirty, busy: task.busy, onClose, description: 'Your unsaved automation changes will be discarded.' });
  return <EditorSheet title={a?.name ?? 'New automation'} busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>{guard.dialog}
    {task.error && <ErrorState message={task.error} />}
    {conflict && <Card><Text>This automation changed. Reload the latest version before saving.</Text><Button label="Reload latest" variant="secondary" disabled={task.busy} onPress={() => { const latest = cleanConfig(a); setConfig(latest); setBaseline(latest); setBase(a.custom?.version); }} /></Card>}
    <AutomationFields value={config} onChange={setConfig} channels={channels} timeZone={a?.timeZone ?? timeZone} disabled={!editable || task.busy} />
    {!a && <>
      <ChoicePicker disabled={task.busy} label="Agent" value={selectedAgent ?? ''} options={(agents ?? []).map((agent) => ({ value: agent._id, label: agent.name }))} onChange={(value) => setAgentId(String(value))} />
      <AudiencePicker value={audience} channelId={channelId} channels={channels.filter(c => c.canPost)} allowTeam={teamAllowed} allowCreator disabled={task.busy} onChange={(next, id) => { setAudience(next); setChannelId(id); }} />
      <Field editable={!task.busy} label="Time zone" value={timeZone} onChangeText={setTimeZone} autoCapitalize="none" autoCorrect={false} hint="An IANA time zone, such as America/Los_Angeles." />
    </>}
    {editable && <Button label={a ? 'Save automation' : 'Create automation'} loading={task.busy} disabled={(!a && audience !== 'creator' && !teamAllowed) || !!customAutomationError(config) || conflict || (!!a && !dirty) || (!a && !selectedAgent)} onPress={() => void task.run(async () => {
      if (a && base !== undefined) await save({ automationId: a.id, config, expectedVersion: base });
      else if (selectedAgent) await create({ config, agentId: selectedAgent as Id<'agents'>, audience, channelId: audience === 'channel' ? channelId : undefined, timeZone });
      guard.complete(); onClose();
    })} />}
  </EditorSheet>;
}

function AutomationFields({ value, onChange, channels, timeZone, disabled }: { value: CustomAutomationConfig; onChange: (value: CustomAutomationConfig) => void; channels: Channel[]; timeZone: string; disabled: boolean }) {
  const trigger = value.trigger;
  const changeTrigger = (next: CustomAutomationConfig['trigger']) => onChange({ ...value, trigger: next });
  return <>
    <Field label="Name" value={value.name} onChangeText={(name) => onChange({ ...value, name })} editable={!disabled} />
    <ChoicePicker label="When" value={trigger.type} disabled={disabled} options={[{ value: 'schedule', label: 'On a schedule' }, { value: 'event', label: 'When something happens here' }, { value: 'webhook', label: 'When another app sends a webhook' }]} onChange={(type) => {
      if (type === 'schedule') changeTrigger({ type, cron: DEFAULT_CRON });
      else if (type === 'event') changeTrigger({ type, event: 'member.joined' });
      else if (type === 'webhook') changeTrigger({ type });
    }} />
    {trigger.type === 'schedule' && <ScheduleEditor cron={scheduleCron(trigger)} timeZone={timeZone} disabled={disabled} onChange={(cron) => changeTrigger({ type: 'schedule', cron })} />}
    {trigger.type === 'event' && <><ChoicePicker label="Event" value={trigger.event} disabled={disabled} options={[{ value: 'member.joined', label: 'Someone joins the workspace' }, { value: 'message.posted', label: 'Someone posts in a channel', disabled: !channels.length }]} onChange={(event) => {
      if (event === 'member.joined') changeTrigger({ type: 'event', event });
      else if (event === 'message.posted' && channels[0]) changeTrigger({ type: 'event', event, channelId: channels[0]._id });
    }} />{trigger.event === 'message.posted' && <ChoicePicker label="Watch channel" value={trigger.channelId} disabled={disabled} options={[...channels.map((channel) => ({ value: channel._id, label: `#${channel.title}` })), ...(!channels.some((channel) => channel._id === trigger.channelId) ? [{ value: trigger.channelId, label: 'Current channel (not accessible)' }] : [])]} onChange={(id) => { if (id) changeTrigger({ ...trigger, channelId: String(id) }); }} />}</>}
    {trigger.type === 'webhook' && <Text tone="muted">After saving, copy the webhook URL into the other app. Its event data goes to the agent with your prompt.</Text>}
    <Field label="What to ask the agent" value={value.prompt} onChangeText={(prompt) => onChange({ ...value, prompt })} multiline editable={!disabled} style={{ minHeight: 160 }} hint="Sent on each run, as the person the automation runs for." />
  </>;
}

function AudiencePicker({ value, channelId, channels, allowCreator, allowTeam = true, disabled, onChange }: { value: AutomationAudience; channelId?: string | null; channels: Channel[]; allowCreator: boolean; allowTeam?: boolean; disabled?: boolean; onChange: (audience: AutomationAudience, channelId?: Id<'chats'>) => void }) {
  return <ChoicePicker label="Runs for" disabled={disabled} value={value === 'channel' ? channelId ?? '' : value} options={[
    ...(allowCreator ? [{ value: 'creator', label: 'Just the creator' }] : []), ...(allowTeam ? [{ value: 'subscribers', label: 'Anyone who turns it on' }] : []),
    ...(allowTeam ? channels.map((channel) => ({ value: channel._id, label: `Post in #${channel.title}` })) : []),
    ...(channelId && !channels.some((channel) => channel._id === channelId) ? [{ value: channelId, label: 'Current channel (not accessible)' }] : []),
  ]} onChange={(selected) => { if (selected === 'creator' || selected === 'subscribers') onChange(selected); else if (typeof selected === 'string' && selected) onChange('channel', selected as Id<'chats'>); }} />;
}

function AutomationSettingSheet({ automation: a, mode, task, onClose }: { automation: Automation; mode: Exclude<DetailMode, 'configuration'>; task: ReturnType<typeof useTask>; onClose: () => void }) {
  const me = useQuery(api.workspace.me);
  const teamAllowed = !!me?.access && can(me.access, 'automations.edit');
  const update = useMutation(api.automations.update);
  const reset = useMutation(api.automations.resetWebhook);
  const agents = useQuery(api.agents.list)?.filter(agent => !agent.archived) ?? [];
  const channels = useQuery(api.chats.list)?.channels ?? [];
  const [notice, setNotice] = useState<string>();
  const { confirm, dialog } = useConfirm();
  const editable = a.canEdit && !a.trash;
  const title = { agent: 'Agent', audience: 'Runs for', webhook: 'Webhook URL', prompt: 'Prompt' }[mode];
  return <EditorSheet title={title} size={mode === 'prompt' ? 'large' : 'content'} busy={task.busy} onClose={onClose}>{dialog}
    {task.error && <ErrorState message={task.error} />}
    {notice && <Text accessibilityLiveRegion="polite">{notice}</Text>}
    {mode === 'prompt' && <Text selectable>{a.prompt}</Text>}
    {mode === 'agent' && <>
      <Text tone="muted">Changes save immediately.</Text>
      <ChoicePicker label="Agent" value={a.agentId} disabled={!editable || task.busy} options={[...agents.map(agent => ({ value: agent._id, label: agent.name })), ...(!agents.some(agent => agent._id === a.agentId) ? [{ value: a.agentId, label: `${a.agentName ?? 'Current agent'} (unavailable)` }] : [])]} onChange={id => { if (editable && typeof id === 'string' && id) void task.run(() => update({ automationId: a.id, agentId: id as Id<'agents'> })); }} />
    </>}
    {mode === 'audience' && <>
      <Text tone="muted">Changes save immediately.</Text>
      <AudiencePicker value={a.audience ?? 'subscribers'} channelId={a.channelId} channels={channels.filter(c => c.canPost)} allowTeam={teamAllowed} allowCreator={!!a.custom} disabled={!editable || task.busy} onChange={(audience, channelId) => { if (editable) void task.run(async () => { if (audience === 'channel' && !await confirm({ title: `Turn on ${a.name}?`, ...consent })) return; await update({ automationId: a.id, audience, channelId }); }); }} />
    </>}
    {mode === 'webhook' && a.webhookUrl && <>
      <Text selectable>{a.webhookUrl}</Text>
      <Text tone="muted">Keep this URL secret: anyone with it can trigger this automation.</Text>
      <Button label="Copy URL" variant="secondary" disabled={task.busy} onPress={() => void task.run(async () => { await Clipboard.setStringAsync(a.webhookUrl!); setNotice('Webhook URL copied.'); })} />
      {editable && <Button label="Make a new URL" variant="ghost" disabled={task.busy} onPress={() => void task.run(async () => { if (!await confirm({ title: 'Make a new URL?', body: 'The current URL stops working immediately.', action: 'Replace URL' })) return; await reset({ automationId: a.id }); setNotice('New webhook URL created.'); })} />}
    </>}
  </EditorSheet>;
}
