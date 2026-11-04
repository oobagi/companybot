import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { can } from '@companybot/core/permissions';
import { customAutomationError, scheduleCron, type CustomAutomationConfig, type AutomationAudience } from '@companybot/core/automations';
import { DEFAULT_CRON } from '@companybot/core/schedules';
import type { FunctionReturnType } from 'convex/server';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Badge, Button, Card, ChoicePicker, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, Section, Stack, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { PendingWakeups } from './customize/PendingWakeups';
import { ScheduleEditor } from './customize/ScheduleEditor';
import { DirectoryHeader } from '@/components/navigation/DirectoryHeader';

type Automation = FunctionReturnType<typeof api.automations.list>[number];
type Channel = { _id: Id<'chats'>; title: string };
const cleanConfig = (a?: Automation): CustomAutomationConfig => a?.custom ? { name: a.custom.name, prompt: a.custom.prompt, trigger: a.custom.trigger.type === 'schedule' ? { type: 'schedule', cron: scheduleCron(a.custom.trigger) } : a.custom.trigger } : { name: '', prompt: '', trigger: { type: 'schedule', cron: DEFAULT_CRON } };
const consent = { body: 'It runs as you. When it needs permission to do something, like post or read your DMs, it asks in your DM with the agent. You can allow that action for later runs there.', action: 'Turn on' };

export default function Automations() {
  const items = useQuery(api.automations.list); const me = useQuery(api.workspace.me);
  const { itemId } = useLocalSearchParams<{ itemId?: string }>();
  const [selected, setSelected] = useState<string | undefined>(() => typeof itemId === 'string' ? itemId : undefined);
  const item = items?.find((a) => a.id === selected);
  const active = items?.filter((a) => !a.trash);
  return <><DirectoryHeader workspaceSwitcher={false} action={me?.role && can(me.role, 'automations.create') ? { label: 'New automation', onPress: () => setSelected('new') } : undefined} /><Screen scroll><Stack style={{ flexGrow: 1 }}>
    {!items ? <Loading /> : !active?.length ? <EmptyState title="No automations yet" description="Have an agent handle routine work on a schedule or event." /> : active.map((a) => <ListRow key={a.id} title={a.name} description={`${a.trigger}\n${a.runsFor ?? ''} · ${a.agentName ?? 'No agent'}`} trailing={<Badge label={a.enabled ? 'Running' : 'Paused'} tone={a.enabled ? 'success' : 'default'} />} onPress={() => setSelected(a.id)} />)}
    <PendingWakeups />
    {(selected === 'new' || item) && <AutomationEditor key={selected} automation={item} onClose={() => setSelected(undefined)} />}
  </Stack></Screen></>;
}
function AutomationEditor({ automation: a, onClose }: { automation?: Automation; onClose: () => void }) {
  const [config, setConfig] = useState(() => cleanConfig(a));
  const [base, setBase] = useState(a?.custom?.version);
  const [agentId, setAgentId] = useState('');
  const [audience, setAudience] = useState<AutomationAudience>('creator');
  const [channelId, setChannelId] = useState<Id<'chats'>>();
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const agents = useQuery(api.agents.list)?.filter((agent) => !agent.archived);
  const channels = useQuery(api.chats.list)?.channels ?? [];
  const create = useMutation(api.automations.create); const save = useMutation(api.automations.save); const remove = useMutation(api.automations.remove);
  const task = useTask(); const { confirm, dialog } = useConfirm();
  const editable = !a || (a.canEdit && !!a.custom && !a.trash);
  const conflict = !!a?.custom && a.custom.version !== base;
  const dirty = JSON.stringify(config) !== JSON.stringify(cleanConfig(a));
  const selectedAgent = agentId || agents?.[0]?._id;
  const close = async () => { if (!editable || !dirty || await confirm({ title: 'Discard changes?', body: 'Your unsaved automation changes will be discarded.', action: 'Discard', danger: true })) onClose(); };
  return <EditorSheet title={a?.name ?? 'New automation'} busy={task.busy} dismissible={!editable || !dirty} onClose={() => void close()}>{dialog}
    {task.error && <ErrorState message={task.error} />}
    {conflict && <Card><Text>This automation changed. Reload the latest version before saving.</Text><Button label="Reload latest" variant="secondary" onPress={() => { setConfig(cleanConfig(a)); setBase(a.custom?.version); }} /></Card>}
    {!a || a.custom ? <AutomationFields value={config} onChange={setConfig} channels={channels} timeZone={a?.timeZone ?? timeZone} disabled={!editable} /> : <><Text>{a.description}</Text><Text>{a.details}</Text><Text variant="label">When</Text><Text>{a.trigger}</Text><Text variant="label">Prompt</Text><Text selectable>{a.prompt}</Text></>}
    {!a && <>
      <ChoicePicker label="Agent" value={selectedAgent ?? ''} options={(agents ?? []).map((agent) => ({ value: agent._id, label: agent.name }))} onChange={(value) => setAgentId(String(value))} />
      <AudiencePicker value={audience} channelId={channelId} channels={channels} allowCreator onChange={(next, id) => { setAudience(next); setChannelId(id); }} />
      <Field label="Time zone" value={timeZone} onChangeText={setTimeZone} autoCapitalize="none" autoCorrect={false} hint="An IANA time zone, such as America/Los_Angeles." />
    </>}
    {editable && <Button label={a ? 'Save automation' : 'Create automation'} loading={task.busy} disabled={!!customAutomationError(config) || conflict || (!!a && !dirty) || (!a && !selectedAgent)} onPress={() => void task.run(async () => {
      if (a && base !== undefined) await save({ automationId: a.id, config, expectedVersion: base });
      else if (selectedAgent) await create({ config, agentId: selectedAgent as Id<'agents'>, audience, channelId: audience === 'channel' ? channelId : undefined, timeZone });
      onClose();
    })} />}
    {a && !a.trash && <AutomationSettings automation={a} />}
    {a?.canEdit && !a.trash && <Button label="Archive automation" variant="danger" disabled={task.busy} onPress={() => void task.run(async () => { if (!await confirm({ title: `Archive ${a.name}?`, body: 'It stops running. Its configuration and permissions remain in Archive.', action: 'Archive', danger: true })) return; await remove({ automationId: a.id }); onClose(); })} />}
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

function AudiencePicker({ value, channelId, channels, allowCreator, disabled, onChange }: { value: AutomationAudience; channelId?: string | null; channels: Channel[]; allowCreator: boolean; disabled?: boolean; onChange: (audience: AutomationAudience, channelId?: Id<'chats'>) => void }) {
  return <ChoicePicker label="Runs for" disabled={disabled} value={value === 'channel' ? channelId ?? '' : value} options={[
    ...(allowCreator ? [{ value: 'creator', label: 'Just the creator' }] : []), { value: 'subscribers', label: 'Anyone who turns it on' },
    ...channels.map((channel) => ({ value: channel._id, label: `Post in #${channel.title}` })),
    ...(channelId && !channels.some((channel) => channel._id === channelId) ? [{ value: channelId, label: 'Current channel (not accessible)' }] : []),
  ]} onChange={(selected) => { if (selected === 'creator' || selected === 'subscribers') onChange(selected); else if (typeof selected === 'string' && selected) onChange('channel', selected as Id<'chats'>); }} />;
}

function AutomationSettings({ automation: a }: { automation: Automation }) {
  const update = useMutation(api.automations.update); const subscribe = useMutation(api.automations.subscribe); const reset = useMutation(api.automations.resetWebhook); const runNow = useMutation(api.automationRuns.runNow);
  const agents = useQuery(api.agents.list)?.filter((agent) => !agent.archived) ?? [];
  const channels = useQuery(api.chats.list)?.channels ?? [];
  const [notice, setNotice] = useState<string>();
  const task = useTask(); const { confirm, dialog } = useConfirm();
  const askEnable = () => confirm({ title: `Turn on ${a.name}?`, ...consent });
  return <Section title="Settings">{dialog}{task.error && <ErrorState message={task.error} />}{notice && <Text accessibilityLiveRegion="polite">{notice}</Text>}
    <Text tone="muted">{a.runsFor} · {a.agentName ?? 'No agent'}{a.agentArchived ? ' (archived)' : ''}</Text>
    {a.audience === 'subscribers' && <Button label={a.subscribed ? 'Turn off for me' : 'Turn on for me'} variant="secondary" loading={task.busy} onPress={() => void task.run(async () => { if (!a.subscribed && !await askEnable()) return; await subscribe({ automationId: a.id, on: !a.subscribed }); })} />}
    {a.canEdit && <>
      <Button label={a.enabled ? 'Pause automation' : 'Resume automation'} variant="secondary" loading={task.busy} onPress={() => void task.run(async () => { if (!a.enabled && !await askEnable()) return; await update({ automationId: a.id, enabled: !a.enabled }); })} />
      <ChoicePicker label="Agent" value={a.agentId} disabled={task.busy} options={[...agents.map((agent) => ({ value: agent._id, label: agent.name })), ...(!agents.some((agent) => agent._id === a.agentId) ? [{ value: a.agentId, label: `${a.agentName ?? 'Current agent'} (unavailable)` }] : [])]} onChange={(id) => { if (typeof id === 'string' && id) void task.run(() => update({ automationId: a.id, agentId: id as Id<'agents'> })); }} />
      <AudiencePicker value={a.audience ?? 'subscribers'} channelId={a.channelId} channels={channels} allowCreator={!!a.custom} disabled={task.busy} onChange={(audience, channelId) => void task.run(async () => { if (audience === 'channel' && !await askEnable()) return; await update({ automationId: a.id, audience, channelId }); })} />
    </>}
    {a.webhookUrl && <Card><Text variant="label">Webhook URL</Text><Text selectable>{a.webhookUrl}</Text><Text tone="muted" variant="caption">Keep this URL secret: anyone with it can trigger this automation.</Text>
      <Button label="Copy URL" variant="secondary" onPress={() => void task.run(async () => { await Clipboard.setStringAsync(a.webhookUrl!); setNotice('Webhook URL copied.'); })} />
      <Button label="Make a new URL" variant="ghost" disabled={task.busy} onPress={() => void task.run(async () => { if (!await confirm({ title: 'Make a new URL?', body: 'The current URL stops working immediately.', action: 'Replace URL' })) return; await reset({ automationId: a.id }); setNotice('New webhook URL created.'); })} />
    </Card>}
    <Text tone="muted">{a.lastRunAt ? `Last ran ${new Date(a.lastRunAt).toLocaleString()}. ${a.lastResult ?? ''}` : 'Has not run yet.'}</Text>
    {a.canEdit && <><Button label="Run now" variant="secondary" loading={task.busy} onPress={() => void task.run(async () => { await runNow({ automationId: a.id }); setNotice(`Started. Check your chat with ${a.agentName ?? 'the agent'}.`); })} /><Text variant="caption" tone="muted">Runs once, just for you{a.scheduled ? '.' : ', using sample event data.'}</Text></>}
  </Section>;
}
