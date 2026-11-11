import { Segmented } from '@/components/ui/Segmented';
import { useState } from 'react';
import { router } from 'expo-router';
import { describeAllowed } from '@companybot/core/action-words';
import { api } from '@/lib/api';
import { usePaginatedQuery, useQuery } from '@/lib/convex';
import { Button, ChoicePicker, Divider, EditorSheet, EmptyState, ListRow, Loading, Screen, ScreenList, Section, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import type { FieldValue } from '@companybot/core/records';
import { valueText } from '@/features/records/model';

type Entry = FunctionReturnType<typeof api.activity.recent>['entries'][number];
type DataEntry = FunctionReturnType<typeof api.records.activity>['page'][number];

export default function Activity() {
  const [tab, setTab] = useState<'agents' | 'records'>('agents');
  const { sizes, spacing } = useTheme();
  // A bounded body keeps the category control visible and centers feedback below it.
  return <Screen padded={false}>
    <Stack style={{ paddingHorizontal: sizes.gutter, paddingVertical: spacing.sm }}>
      <Segmented label="Activity type" options={[{ value: 'agents', label: 'Agent actions' }, { value: 'records', label: 'Data changes' }]} value={tab} onChange={value => setTab(value === 'agents' ? 'agents' : 'records')} />
    </Stack>
    {tab === 'agents' ? <AgentActivity /> : <DataActivity />}
  </Screen>;
}

function AgentActivity() {
  const { sizes, spacing } = useTheme();
  const agents = useQuery(api.agents.list);
  const [agentId, setAgentId] = useState<Id<'agents'>>();
  const [changesOnly, setChangesOnly] = useState(true);
  const activity = useQuery(api.activity.recent, { agentId });
  const [detailId, setDetailId] = useState<string>();
  const entries = activity?.entries;
  const shown = entries?.filter(entry => !changesOnly || entry.changes || entry.wake) ?? [];
  const detail = entries?.find(entry => entry._id === detailId);
  const filtered = !!agentId || !!entries?.length;
  return <>
    <Stack gap="none" style={{ paddingHorizontal: sizes.gutter, paddingBottom: spacing.sm }}>
      <ChoicePicker allowEmpty emptyLabel="All agents" label="Agent" value={agentId ?? ''} disabled={agents === undefined} options={(agents ?? []).map(agent => ({ value: agent._id, label: agent.name }))} onChange={value => setAgentId(typeof value === 'string' && value ? value as Id<'agents'> : undefined)} />
      <ChoicePicker label="Show" value={changesOnly ? 'changes' : 'all'} options={[{ value: 'changes', label: 'Changes only' }, { value: 'all', label: 'All actions' }]} onChange={value => setChangesOnly(value !== 'all')} />
    </Stack>
    <ScreenList data={shown} keyExtractor={entry => entry._id} contentContainerStyle={{ paddingHorizontal: sizes.gutter }} ItemSeparatorComponent={Divider}
      ListHeaderComponent={activity?.truncated ? <Text variant="supporting" tone="muted" style={{ paddingVertical: spacing.sm }}>Activity history is limited. Open a reply to see its actions.</Text> : undefined}
      ListEmptyComponent={entries === undefined ? <Loading label="Loading activity…" /> : <EmptyState title={filtered ? 'No matching activity' : 'No agent activity yet'} description={filtered ? 'Try another agent or show all actions.' : 'Actions taken by your agents will appear here.'} />}
      renderItem={({ item }) => <ListRow title={item.label} description={`${item.agent} · ${item.chat}\n${new Date(item.time).toLocaleString()}`} value={item.status === 'error' ? 'Failed' : undefined} disclosure onPress={() => setDetailId(item._id)} />} />
    {detailId && <EditorSheet title="Agent action" onClose={() => setDetailId(undefined)}>
      {entries === undefined ? <Loading /> : detail ? <AgentDetail entry={detail} onClose={() => setDetailId(undefined)} /> : <EmptyState title="Activity unavailable" description="This action is no longer in the accessible activity history." />}
    </EditorSheet>}
  </>;
}

function AgentDetail({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  return <>
    <Stack gap="xs"><Text variant="heading">{entry.label}</Text><Text variant="supporting" tone="muted">{entry.agent} acting for {entry.mine ? 'you' : entry.actor}</Text><Text variant="supporting" tone="muted">{entry.chat} · {new Date(entry.time).toLocaleString()}</Text></Stack>
    <Section title="Input"><Text selectable>{entry.input}</Text></Section>
    {entry.error !== undefined && <Section title="Error"><Text selectable tone="danger">{entry.error}</Text></Section>}
    {entry.output !== undefined && <Section title="Result"><Text selectable>{entry.output}</Text></Section>}
    {entry.error === undefined && entry.output === undefined && !entry.wake && <Text variant="supporting" tone="muted">Only {entry.actor} can see the result.</Text>}
    {entry.allowed && <Text variant="supporting" tone="muted">{describeAllowed({ ...entry.allowed, automation: entry.allowed.automation ?? undefined }, entry.allowed.by)}{entry.allowed.ruleStillOn === false ? ' · Rule since removed' : ''}</Text>}
    <Button label="Open conversation" onPress={() => {
      onClose();
      router.push(entry.threadId
        ? { pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: entry.chatId, threadId: entry.threadId, messageId: entry.replyId ?? undefined } }
        : { pathname: '/chat/[chatId]', params: { chatId: entry.chatId, messageId: entry.replyId ?? undefined } });
    }} />
  </>;
}

const actionLabels: Record<string, string> = { created: 'Created', updated: 'Changed', archived: 'Archived', restored: 'Restored', deleted: 'Deleted' };
function dataAction(entry: DataEntry) {
  const [kind, action] = entry.action.includes('.') ? entry.action.split('.') : ['record', entry.action];
  return `${entry.undoes ? 'Undid a change to' : actionLabels[action!] ?? action} ${kind}`;
}
const dataSubject = (entry: DataEntry) => entry.subject ?? entry.record ?? entry.field ?? entry.type ?? 'Unavailable item';
const dataActor = (entry: DataEntry) => entry.agent ? `${entry.agent}, acting for ${entry.user}` : entry.user;

function DataActivity() {
  const { sizes } = useTheme();
  const rows = usePaginatedQuery(api.records.activity, {}, { initialNumItems: 30 });
  const [detailId, setDetailId] = useState<string>();
  const detail = rows.results.find(entry => entry._id === detailId);
  return <>
    <ScreenList data={rows.results} keyExtractor={entry => entry._id} contentContainerStyle={{ paddingHorizontal: sizes.gutter }} ItemSeparatorComponent={Divider}
      ListEmptyComponent={rows.status === 'LoadingFirstPage' || rows.status === 'LoadingMore' ? <Loading label="Loading changes…" /> : rows.status === 'CanLoadMore' ? <EmptyState title="No changes in this part of the history" description="Load more to check earlier activity." /> : <EmptyState title="No data changes yet" description="Changes to your databases, fields and records will appear here." />}
      renderItem={({ item }) => <ListRow title={dataSubject(item)} description={`${dataAction(item)} · ${dataActor(item)}\n${new Date(item.time).toLocaleString()}`} value={item.fieldChange?.running ? 'Converting…' : undefined} disclosure onPress={() => setDetailId(item._id)} />}
      ListFooterComponent={rows.status === 'CanLoadMore' ? <Button label="Load more" variant="ghost" onPress={() => rows.loadMore(30)} /> : rows.status === 'LoadingMore' && rows.results.length > 0 ? <Loading layout="inline" label="Loading more changes…" /> : undefined} />
    {detailId && <EditorSheet title="Data change" onClose={() => setDetailId(undefined)}>
      {detail ? <>
        <Stack gap="xs"><Text variant="heading">{dataSubject(detail)}</Text><Text>{dataAction(detail)}</Text><Text variant="supporting" tone="muted">{dataActor(detail)} · {new Date(detail.time).toLocaleString()}</Text></Stack>
        {detail.fieldChange && <Text variant="supporting" tone="muted">{detail.fieldChange.running ? 'Converting field values…' : `${detail.fieldChange.converted.toLocaleString()} values converted${detail.fieldChange.cleared ? `, ${detail.fieldChange.cleared.toLocaleString()} cleared` : ''}.`}</Text>}
        {detail.changes.map(change => <Section key={change.key} title={change.label}>
          <Text variant="supporting" tone="muted">Before</Text><Text selectable>{valueText(undefined, change.old as FieldValue | undefined, detail.refs) || 'Empty'}</Text>
          <Text variant="supporting" tone="muted">After</Text><Text selectable>{valueText(undefined, change.new as FieldValue | undefined, detail.refs) || 'Empty'}</Text>
        </Section>)}
      </> : rows.status === 'LoadingFirstPage' ? <Loading /> : <EmptyState title="Change unavailable" description="This change is no longer in the accessible activity history." />}
    </EditorSheet>}
  </>;
}
