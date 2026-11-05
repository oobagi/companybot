import { agentNameError, pickAgentConfig, reasonings, type AgentConfig } from '@companybot/core/agent-config';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { can } from '@companybot/core/permissions';
import type { FunctionReturnType } from 'convex/server';
import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Avatar, Badge, Button, Card, ChoicePicker, Divider, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Section, Text, useConfirm } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { ImageControl } from './customize/ImageControl';
import { NavigationHeader } from '@/components/navigation/NavigationHeader';

type Agent = FunctionReturnType<typeof api.agents.list>[number];
export default function Agents() {
  const agents = useQuery(api.agents.list);
  const me = useQuery(api.workspace.me);
  const { itemId } = useLocalSearchParams<{ itemId?: string }>();
  const [selected, setSelected] = useState<string | undefined>(() => typeof itemId === 'string' ? itemId : undefined);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const owner = !!me?.access && can(me.access, 'agents.manage');
  const query = search.trim().toLocaleLowerCase();
  const active = agents?.filter((agent) => !agent.archived && (!query || `${agent.name} ${agent.description}`.toLocaleLowerCase().includes(query)));
  const item = agents?.find((agent) => agent._id === selected);
  return <>
    <NavigationHeader search={{ placeholder: 'Search agents', value: search, onChange: setSearch }} action={owner ? { label: 'New agent', onPress: () => setCreating(true) } : undefined} />
    <Screen nativeScroll padded={false}><ScreenList data={active ?? []} keyExtractor={agent => agent._id} ItemSeparatorComponent={Divider}
      renderItem={({ item: agent }) => <ListRow title={agent.name} description={agent.description} leading={<Avatar name={agent.name} image={agent.image} agent />} onPress={() => setSelected(agent._id)} />}
      ListEmptyComponent={!agents ? <Loading /> : <EmptyState title={query ? 'No matching agents' : 'No agents yet'} description={query ? 'Try another name or description.' : "Add a teammate to help with your team's work."} />} />
    </Screen>
    {item && <AgentEditor key={item._id} agent={item} owner={owner} onClose={() => setSelected(undefined)} />}
    {creating && <NewAgent onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelected(id); }} />}
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
  // the full editor. Swapping two SwiftUI modals in one render can lose the second one.
  return <EditorSheet title="New agent" size="content" busy={task.busy || !!created} dismissible={guard.dismissible} open={!created} onClose={() => void guard.close()} onDismiss={() => { if (created) onCreated(created); }}>
    {guard.dialog}
    <Field label="Name" value={name} onChangeText={setName} autoFocus autoCorrect={false} maxLength={40} editable={!task.busy && !created} hint="Up to 40 characters. You can customize the agent after creating it." error={name.length > 0 ? problem ?? undefined : undefined} />
    {task.error && <ErrorState message={task.error} />}
    <Button label="Create agent" loading={task.busy || !!created} disabled={!!problem} onPress={() => { if (!problem) void task.run(async () => setCreated(await create({ name: name.trim() }))); }} />
  </EditorSheet>;
}
function AgentEditor({ agent, owner, onClose }: { agent: Agent; owner: boolean; onClose: () => void }) {
  const [baseline, setBaseline] = useState(() => pickAgentConfig(agent));
  const [config, setConfig] = useState(baseline);
  const [base, setBase] = useState(agent.version);
  const [version, setVersion] = useState<number>();
  const options = useQuery(api.agents.options);
  const history = useQuery(api.agents.history, { agentId: agent._id });
  const update = useMutation(api.agents.update);
  const archive = useMutation(api.trash.move);
  const restore = useMutation(api.agents.restore);
  const task = useTask();
  const { confirm, dialog } = useConfirm();
  const [pictureBusy, setPictureBusy] = useState(false);
  const busy = task.busy || pictureBusy;
  const editable = owner && !agent.archived;
  const edit = (changes: Partial<AgentConfig>) => { if (editable && !busy) setConfig((value) => ({ ...value, ...changes })); };
  const dirty = JSON.stringify(config) !== JSON.stringify(baseline);
  const nameProblem = agentNameError(config.name);
  const guard = useDraftGuard({ dirty: editable && dirty, busy, onClose, description: 'Your unsaved agent settings will be discarded.' });
  return <EditorSheet title={agent.name} onClose={() => void guard.close()} busy={busy} dismissible={guard.dismissible}>
    {dialog}{guard.dialog}
    {agent.archived && <Badge label="Archived · read only" tone="warning" />}
    <Text tone="muted" variant="caption">v{agent.version} · {agent.updatedByName} · {new Date(agent.updatedAt).toLocaleString()}</Text>
    {base !== agent.version && <Card><Text>Someone changed this agent. Reload the latest settings before saving.</Text><Button label="Reload latest" variant="secondary" disabled={busy} onPress={() => { setConfig(pickAgentConfig(agent)); setBaseline(pickAgentConfig(agent)); setBase(agent.version); }} /></Card>}
    {task.error && <ErrorState message={task.error} />}
    <ImageControl of={agent._id} name={agent.name} image={agent.image} disabled={!editable || task.busy} onBusyChange={setPictureBusy} agent />
    <Field label="Name" value={config.name} onChangeText={(name) => edit({ name })} editable={editable && !busy} maxLength={40} error={editable ? nameProblem ?? undefined : undefined} />
    <Field label="Description" value={config.description} onChangeText={(description) => edit({ description })} editable={editable && !busy} />
    <ChoicePicker label="Model" value={config.model} disabled={!editable || busy} options={[...(options?.models ?? []).map((model) => ({ value: model.id, label: model.name })), ...(!options?.models.some((model) => model.id === config.model) ? [{ value: config.model, label: config.model }] : [])]} onChange={(model) => edit({ model: String(model) })} />
    <ChoicePicker label="Reasoning" value={config.reasoning ?? 'medium'} disabled={!editable || busy} options={reasonings.map((value) => ({ value, label: value === 'none' ? 'Off' : value[0]!.toUpperCase() + value.slice(1) }))} onChange={(value) => { if (reasonings.includes(value as typeof reasonings[number])) edit({ reasoning: value as typeof reasonings[number] }); }} />
    <Text tone="muted" variant="caption">Higher reasoning takes longer and costs more, but can help with harder work.</Text>
    <Section title="Tools">{options?.groups.map((group) => {
      const grant = group.tools.length === 1 ? group.tools[0]!.id : `${group.id}.*`;
      const whole = config.tools.includes(grant) || config.tools.includes(`${group.id}.*`);
      return <Card key={group.id}><ListRow title={`${group.name}${group.connector ? ' (connector)' : ''}`} description="All tools, including future additions" selected={whole} disabled={!editable || busy} trailing={<Text>{whole ? '✓' : '○'}</Text>} onPress={() => edit({ tools: whole ? config.tools.filter((id) => id !== grant && !id.startsWith(`${group.id}.`)) : [...config.tools.filter((id) => !id.startsWith(`${group.id}.`)), grant] })} />
        {group.tools.length > 1 && <ChoicePicker label="Individual tools" disabled={!editable || busy || whole} value={config.tools.filter((id) => group.tools.some((tool) => tool.id === id))} multiple options={group.tools.map((tool) => ({ value: tool.id, label: `${tool.id}${tool.needs ? ` · Requires permission to ${tool.needs}` : ''} — ${tool.description}` }))} onChange={(value) => edit({ tools: [...config.tools.filter((id) => !group.tools.some((tool) => tool.id === id)), ...(Array.isArray(value) ? value : [value])] })} />}
      </Card>;
    })}</Section>
    <Field label="Instructions" hint="Changes apply from the next reply." value={config.instructions} onChangeText={(instructions) => edit({ instructions })} multiline editable={editable && !busy} style={{ minHeight: 180 }} />
    {editable && <><Button label="Save agent" loading={task.busy} disabled={pictureBusy || !dirty || base !== agent.version || !!nameProblem} onPress={() => void task.run(async () => { if (pictureBusy || nameProblem || base !== agent.version) return; await update({ agentId: agent._id, expectedVersion: base, config }); guard.complete(); onClose(); })} />
      <Button label="Archive agent" variant="danger" disabled={busy} onPress={() => void task.run(async () => { if (pictureBusy) return; if (!await confirm({ title: `Archive ${agent.name}?`, body: 'The agent will stop responding. Its chats and memories stay in Archive.', action: 'Archive', danger: true })) return; await archive({ kind: 'agent', id: agent._id }); guard.complete(); onClose(); })} /></>}
    <Section title="History">{history?.map((saved) => <Card key={saved.version}><ListRow title={`Version ${saved.version}${saved.version === agent.version ? ' · current' : ''}`} description={`${saved.savedByName} · ${new Date(saved.savedAt).toLocaleString()}`} onPress={() => setVersion(version === saved.version ? undefined : saved.version)} />
      {version === saved.version && <><Text variant="label">{saved.config.name}</Text><Text>{saved.config.description}</Text><Text tone="muted">{saved.config.model} · {saved.config.reasoning ?? 'medium'} reasoning</Text><Text selectable>{saved.config.instructions || 'No instructions'}</Text><Text tone="muted">Tools: {saved.config.tools.join(', ') || 'None'}</Text>
        {editable && saved.version !== agent.version && <Button label="Restore version" variant="secondary" loading={task.busy} disabled={pictureBusy} onPress={() => void task.run(async () => { if (pictureBusy) return; if (!await confirm({ title: `Restore version ${saved.version}?`, body: 'This creates a new version. Existing history is kept.', action: 'Restore' })) return; await restore({ agentId: agent._id, version: saved.version, expectedVersion: agent.version }); guard.complete(); onClose(); })} />}</>}
    </Card>)}</Section>
  </EditorSheet>;
}
