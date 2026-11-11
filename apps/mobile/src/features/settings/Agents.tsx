import { useTheme } from '@/design';
import { agentNameError, pickAgentConfig, reasonings, type AgentConfig } from '@companybot/core/agent-config';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { can } from '@companybot/core/permissions';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
import { router, Stack as RouterStack, useLocalSearchParams } from 'expo-router';
import { Avatar, Button, ChoicePicker, Divider, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Section, SettingsRow, Stack, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { ImageControl } from './customize/ImageControl';
import { NavigationHeader } from '@/components/navigation/NavigationHeader';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import type { Action } from '@/components/ui/ActionMenu';

type Agent = FunctionReturnType<typeof api.agents.list>[number];
export default function Agents() {
  const { sizes } = useTheme();
  const agents = useQuery(api.agents.list);
  const me = useQuery(api.workspace.me);
  const { itemId } = useLocalSearchParams<{ itemId?: string }>();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const owner = !!me?.access && can(me.access, 'agents.manage');
  const query = search.trim().toLocaleLowerCase();
  const active = agents?.filter((agent) => !agent.archived && (!query || `${agent.name} ${agent.description}`.toLocaleLowerCase().includes(query)));
  const item = agents?.find((agent) => agent._id === itemId);
  const openAgent = (id: string) => router.push({ pathname: '/settings/[section]', params: { section: 'agents', itemId: id } });
  if (itemId) return agents === undefined ? <Screen><Loading /></Screen> : item ? <AgentDetail key={item._id} agent={item} owner={owner} /> : <Screen><EmptyState title="Agent unavailable" description="It may have been removed or you may no longer have access." /></Screen>;
  return <>
    <NavigationHeader search={{ placeholder: 'Search agents', value: search, onChange: setSearch }} action={owner ? { label: 'New agent', onPress: () => setCreating(true) } : undefined} />
    <Screen nativeScroll padded={false}><ScreenList contentContainerStyle={{ paddingHorizontal: sizes.gutter }} data={active ?? []} keyExtractor={agent => agent._id} ItemSeparatorComponent={Divider}
      renderItem={({ item: agent }) => <ListRow title={agent.name} description={agent.description} leading={<Avatar name={agent.name} image={agent.image} agent />} onPress={() => openAgent(agent._id)} />}
      ListEmptyComponent={!agents ? <Loading /> : <EmptyState title={query ? 'No matching agents' : 'No agents yet'} description={query ? 'Try another name or description.' : "Add a teammate to help with your team's work."} />} />
    </Screen>
    {creating && <NewAgent onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); openAgent(id); }} />}
  </>;
}

function NewAgent({ onClose, onCreated }: { onClose: () => void; onCreated: (id: Id<'agents'>) => void }) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<Id<'agents'>>();
  const create = useMutation(api.agents.create);
  const task = useTask();
  const problem = agentNameError(name);
  const guard = useDraftGuard({ dirty: name !== '', busy: task.busy || !!created, onClose, description: 'Your unsaved agent name will be discarded.' });
  // Keep the first native sheet mounted until its dismissal completes before presenting
  // the detail route. Navigation during dismissal can leave native presentation state stale.
  return <EditorSheet title="New agent" size="content" busy={task.busy || !!created} dismissible={guard.dismissible} open={!created} onClose={() => void guard.close()} onDismiss={() => { if (created) { guard.complete(); onCreated(created); } }} submit={{ label: 'Create', disabled: !!problem, onPress: () => { if (!problem) void task.run(async () => setCreated(await create({ name: name.trim() }))); } }}>
    {guard.dialog}
    <Field label="Name" value={name} onChangeText={setName} autoFocus autoCorrect={false} maxLength={40} editable={!task.busy && !created} hint="Up to 40 characters. You can customize the agent after creating it." error={name.length > 0 ? problem ?? undefined : undefined} />
    {task.error && <ErrorState message={task.error} />}
  </EditorSheet>;
}
type DetailMode = 'edit' | 'picture' | 'history';
function AgentDetail({ agent, owner }: { agent: Agent; owner: boolean }) {
  const [mode, setMode] = useState<DetailMode>();
  const options = useQuery(api.agents.options);
  const archive = useMutation(api.trash.move);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const guard = useDraftGuard({ dirty: false, busy: task.busy, onClose: () => {} });
  const editable = owner && !agent.archived;
  const actions: Action[] = [
    ...(editable ? [{ id: 'edit', title: 'Edit agent', icon: 'pencil' as const }, { id: 'picture', title: 'Change picture', icon: 'photo' as const }] : []),
    { id: 'history', title: 'Version history', icon: 'clock.arrow.circlepath' },
    ...(editable ? [{ id: 'archive', title: 'Archive agent', icon: 'archivebox' as const, destructive: true }] : []),
  ];
  return <>
    <RouterStack.Screen options={{ title: agent.name }} />
    <HeaderMenu label="Agent actions" actions={actions.map(action => ({ ...action, disabled: task.busy || !!mode }))} onAction={id => {
      if (task.busy || mode) return;
      task.clear();
      if (id === 'history') setMode('history');
      else if (editable && (id === 'edit' || id === 'picture')) setMode(id);
      else if (editable && id === 'archive') void task.run(async () => {
        if (!await confirm({ title: `Archive ${agent.name}?`, body: 'The agent will stop responding. Its chats and memories stay in Archive.', action: 'Archive', danger: true })) return;
        await archive({ kind: 'agent', id: agent._id });
      });
    }} />
    <Screen scroll>{dialog}{guard.dialog}<Stack>
      {task.error && <ErrorState message={task.error} />}
      <Stack horizontal><Avatar name={agent.name} image={agent.image} agent size="lg" /><Text style={{ flex: 1 }}>{agent.description || 'No description yet.'}</Text></Stack>
      {agent.archived && <Text tone="muted">Archived. This agent no longer responds; its history is kept.</Text>}
      <Section title="Model"><Text>{options?.models.find(model => model.id === agent.model)?.name ?? agent.model}</Text><Text variant="supporting" tone="muted">{agent.reasoning === 'none' ? 'Reasoning off' : `${reasoningLabel(agent.reasoning)} reasoning`}</Text></Section>
      <Section title="Instructions"><Text selectable>{agent.instructions || 'No custom instructions.'}</Text></Section>
      <Section title="Tools"><Stack gap="sm">{agent.tools.length ? agent.tools.map(id => <Text key={id}>{toolLabel(id, options)}</Text>) : <Text tone="muted">No tools enabled.</Text>}</Stack></Section>
      <Text variant="supporting" tone="muted">Version {agent.version} · Updated by {agent.updatedByName} · {new Date(agent.updatedAt).toLocaleString()}</Text>
    </Stack></Screen>
    {mode === 'edit' && <AgentEditor agent={agent} owner={owner} onClose={() => setMode(undefined)} />}
    {mode === 'picture' && <AgentPicture agent={agent} editable={editable} onClose={() => setMode(undefined)} />}
    {mode === 'history' && <AgentHistory agent={agent} editable={editable} onClose={() => setMode(undefined)} />}
  </>;
}

const reasoningLabel = (value: Agent['reasoning']) => value === 'none' ? 'Off' : (value ?? 'medium')[0]!.toUpperCase() + (value ?? 'medium').slice(1);
function toolLabel(id: string, options: FunctionReturnType<typeof api.agents.options> | undefined) {
  const group = options?.groups.find(group => id === `${group.id}.*` || group.tools.some(tool => tool.id === id));
  if (!group) return id;
  return id.endsWith('.*') ? `${group.name} · All tools` : group.tools.length === 1 ? group.name : `${group.name} · ${id.slice(id.indexOf('.') + 1).replaceAll('_', ' ')}`;
}

function AgentPicture({ agent, editable, onClose }: { agent: Agent; editable: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const guard = useDraftGuard({ dirty: false, busy, onClose });
  return <EditorSheet title="Agent picture" size="content" busy={busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>
    {guard.dialog}<ImageControl of={agent._id} name={agent.name} image={agent.image} disabled={!editable} onBusyChange={setBusy} agent />
    <Text variant="supporting" tone="muted">Picture changes save immediately.</Text>
  </EditorSheet>;
}

function AgentHistory({ agent, editable, onClose }: { agent: Agent; editable: boolean; onClose: () => void }) {
  const history = useQuery(api.agents.history, { agentId: agent._id });
  const options = useQuery(api.agents.options);
  const [version, setVersion] = useState<number>();
  const saved = history?.find(entry => entry.version === version);
  const restore = useMutation(api.agents.restore);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const guard = useDraftGuard({ dirty: false, busy: task.busy, onClose });
  return <EditorSheet title={version === undefined ? 'Version history' : `Version ${version}`} busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>
    {dialog}{guard.dialog}{task.error && <ErrorState message={task.error} />}
    {version !== undefined && <Button label="All versions" variant="ghost" disabled={task.busy} onPress={() => { task.clear(); setVersion(undefined); }} />}
    {history === undefined ? <Loading /> : version === undefined ? <Stack gap="none">{history.length ? history.map(entry => <ListRow key={entry.version} title={`Version ${entry.version}${entry.version === agent.version ? ' · Current' : ''}`} description={`${entry.savedByName} · ${new Date(entry.savedAt).toLocaleString()}`} disclosure onPress={() => setVersion(entry.version)} />) : <EmptyState title="No version history" />}</Stack> : saved ? <>
      <Stack gap="xs"><Text variant="heading">{saved.config.name}</Text><Text>{saved.config.description}</Text><Text variant="supporting" tone="muted">{saved.savedByName} · {new Date(saved.savedAt).toLocaleString()}</Text></Stack>
      <Section title="Model"><Text>{options?.models.find(model => model.id === saved.config.model)?.name ?? saved.config.model}</Text><Text variant="supporting" tone="muted">{reasoningLabel(saved.config.reasoning)} reasoning</Text></Section>
      <Section title="Instructions"><Text selectable>{saved.config.instructions || 'No custom instructions.'}</Text></Section>
      <Section title="Tools"><Stack gap="sm">{saved.config.tools.length ? saved.config.tools.map(id => <Text key={id}>{toolLabel(id, options)}</Text>) : <Text tone="muted">No tools enabled.</Text>}</Stack></Section>
      {editable && saved.version !== agent.version && <Button label="Restore version" variant="secondary" loading={task.busy} onPress={() => void task.run(async () => {
        if (!await confirm({ title: `Restore version ${saved.version}?`, body: 'This creates a new version. Existing history is kept.', action: 'Restore' })) return;
        await restore({ agentId: agent._id, version: saved.version, expectedVersion: agent.version }); guard.complete(); onClose();
      })} />}
    </> : <EmptyState title="Version unavailable" />}
  </EditorSheet>;
}

function AgentEditor({ agent, owner, onClose }: { agent: Agent; owner: boolean; onClose: () => void }) {
  const [baseline, setBaseline] = useState(() => pickAgentConfig(agent));
  const [config, setConfig] = useState(baseline);
  const [base, setBase] = useState(agent.version);
  const options = useQuery(api.agents.options);
  const update = useMutation(api.agents.update);
  const task = useTask();
  const busy = task.busy;
  const editable = owner && !agent.archived;
  const edit = (changes: Partial<AgentConfig>) => { if (editable && !busy) setConfig((value) => ({ ...value, ...changes })); };
  const dirty = JSON.stringify(config) !== JSON.stringify(baseline);
  const nameProblem = agentNameError(config.name);
  const guard = useDraftGuard({ dirty, busy, onClose, description: 'Your unsaved agent settings will be discarded.' });
  const save = () => void task.run(async () => {
    if (!editable || nameProblem || base !== agent.version || !dirty) return;
    await update({ agentId: agent._id, expectedVersion: base, config }); guard.complete(); onClose();
  });
  return <EditorSheet title={agent.name} onClose={() => void guard.close()} busy={busy} dismissible={guard.dismissible} submit={editable ? { disabled: !dirty || base !== agent.version || !!nameProblem, onPress: save } : undefined}>
    {guard.dialog}
    {!editable && <Text tone="muted">This agent can no longer be edited. Your draft is kept until you discard it.</Text>}
    {base !== agent.version && <Stack><Text>Someone changed this agent. Reload the latest settings before saving.</Text><Button label="Reload latest" variant="secondary" disabled={busy} onPress={() => { setConfig(pickAgentConfig(agent)); setBaseline(pickAgentConfig(agent)); setBase(agent.version); }} /></Stack>}
    {task.error && <ErrorState message={task.error} />}
    <Field label="Name" value={config.name} onChangeText={(name) => edit({ name })} editable={editable && !busy} maxLength={40} error={editable ? nameProblem ?? undefined : undefined} />
    <Field label="Description" multiline value={config.description} onChangeText={(description) => edit({ description })} editable={editable && !busy} />
    <ChoicePicker label="Model" value={config.model} disabled={!editable || busy} options={[...(options?.models ?? []).map((model) => ({ value: model.id, label: model.name })), ...(!options?.models.some((model) => model.id === config.model) ? [{ value: config.model, label: config.model }] : [])]} onChange={(model) => edit({ model: String(model) })} />
    <ChoicePicker label="Reasoning" value={config.reasoning ?? 'medium'} disabled={!editable || busy} options={reasonings.map((value) => ({ value, label: value === 'none' ? 'Off' : value[0]!.toUpperCase() + value.slice(1) }))} onChange={(value) => { if (reasonings.includes(value as typeof reasonings[number])) edit({ reasoning: value as typeof reasonings[number] }); }} />
    <Text tone="muted" variant="supporting">Higher reasoning takes longer and costs more, but can help with harder work.</Text>
    <Section title="Tools">{options?.groups.map((group) => {
      const grant = group.tools.length === 1 ? group.tools[0]!.id : `${group.id}.*`;
      const whole = config.tools.includes(grant) || config.tools.includes(`${group.id}.*`);
      return <Stack key={group.id} gap="sm"><SettingsRow row={{ id: group.id, kind: 'toggle', title: `${group.name}${group.connector ? ' (connector)' : ''}`, subtitle: 'All tools, including future additions', value: whole, disabled: !editable || busy, onValueChange: on => edit({ tools: on ? [...config.tools.filter(id => !id.startsWith(`${group.id}.`)), grant] : config.tools.filter(id => id !== grant && !id.startsWith(`${group.id}.`)) }) }} />
        {group.tools.length > 1 && !whole && <ChoicePicker label="Individual tools" disabled={!editable || busy} value={config.tools.filter((id) => group.tools.some((tool) => tool.id === id))} multiple options={group.tools.map((tool) => ({ value: tool.id, label: `${tool.id}${tool.needs ? ` · Requires permission to ${tool.needs}` : ''}. ${tool.description}` }))} onChange={(value) => edit({ tools: [...config.tools.filter((id) => !group.tools.some((tool) => tool.id === id)), ...(Array.isArray(value) ? value : [value])] })} />}
      </Stack>;
    })}</Section>
    <Field label="Instructions" hint="Changes apply from the next reply." value={config.instructions} onChangeText={(instructions) => edit({ instructions })} multiline editable={editable && !busy} style={{ minHeight: 180 }} />
  </EditorSheet>;
}
