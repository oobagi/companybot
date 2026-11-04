import { Segmented } from '@/components/ui/Segmented';
import { useState } from 'react';
import { FlatList } from 'react-native';
import { router } from 'expo-router';
import { api } from '@/lib/api';
import { usePaginatedQuery, useQuery } from '@/lib/convex';
import { Badge, Button, Card, ChoicePicker, EditorSheet, EmptyState, ListRow, Loading, Screen, Text } from '@/components/ui';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import type { FieldValue } from '@companybot/core/records';
import { valueText } from '@/features/records/model';

type Entry = FunctionReturnType<typeof api.activity.list>[number];
export default function Activity() {
  const [tab, setTab] = useState<'agents' | 'records'>('agents');
  return <Screen><Segmented label="Activity type" options={[{ value: 'agents', label: 'Agent actions' }, { value: 'records', label: 'Data changes' }]} value={tab} onChange={value => setTab(value === 'agents' ? 'agents' : 'records')} />{tab === 'agents' ? <AgentActivity /> : <DataActivity />}</Screen>;
}
function AgentActivity() {
  const agents = useQuery(api.agents.list);
  const [agentId, setAgentId] = useState<Id<'agents'>>();
  const [changesOnly, setChangesOnly] = useState(true);
  const entries = useQuery(api.activity.list, { agentId });
  const [detail, setDetail] = useState<Entry>();
  if (!entries) return <Loading />;
  return <><ChoicePicker allowEmpty emptyLabel="All agents" label="Agent" value={agentId ?? ''} options={(agents ?? []).map(a => ({ value: a._id, label: a.name }))} onChange={v => setAgentId(typeof v === 'string' && v ? v as Id<'agents'> : undefined)} /><ChoicePicker label="Show" value={changesOnly ? 'changes' : 'all'} options={[{ value: 'changes', label: 'Changes only' }, { value: 'all', label: 'All actions' }]} onChange={v => setChangesOnly(v !== 'all')} /><FlatList contentContainerStyle={{ flexGrow: 1 }} data={changesOnly ? entries.filter(e => e.changes || e.wake) : entries} keyExtractor={e => e._id} ListEmptyComponent={<EmptyState title="No agent activity yet" />} renderItem={({ item }) => <ListRow title={item.label} description={`${item.agent} · ${item.chat} · ${new Date(item.time).toLocaleString()}`} trailing={<Badge label={item.status} />} onPress={() => setDetail(item)} />} />
  {detail && <EditorSheet title={detail.label} onClose={() => setDetail(undefined)}><Text>{detail.agent} acting for {detail.actor}</Text>{detail.error && <Text tone="danger">{detail.error}</Text>}<Text variant="label">Input</Text><Text selectable>{detail.input}</Text>{detail.output !== undefined && <><Text variant="label">Result</Text><Text selectable>{detail.output}</Text></>}{detail.allowed && <Text tone="muted">Allowed by {detail.allowed.by} · {detail.allowed.how}</Text>}<Button label="Open conversation" onPress={() => {
    setDetail(undefined);
    router.push(detail.threadId
      ? { pathname: '/chat/[chatId]/thread/[threadId]', params: { chatId: detail.chatId, threadId: detail.threadId, messageId: detail.replyId ?? undefined } }
      : { pathname: '/chat/[chatId]', params: { chatId: detail.chatId, messageId: detail.replyId ?? undefined } });
  }} /></EditorSheet>}</>;
}
function DataActivity() {
  const rows = usePaginatedQuery(api.records.activity, {}, { initialNumItems: 30 });
  return <FlatList contentContainerStyle={{ flexGrow: 1 }} data={rows.results} keyExtractor={r => r._id} ListEmptyComponent={rows.status === 'LoadingFirstPage' ? <Loading /> : <EmptyState title="No data changes yet" />} renderItem={({ item }) => <Card><Text>{item.subject ?? item.record ?? item.field ?? item.type} · {item.action}</Text><Text tone="muted">{item.agent ? `${item.agent}, for ` : ''}{item.user} · {new Date(item.time).toLocaleString()}</Text>{item.changes.map(change => <Text key={change.key}>{change.label}: {valueText(undefined, change.old as FieldValue | undefined, item.refs) || 'empty'} → {valueText(undefined, change.new as FieldValue | undefined, item.refs) || 'empty'}</Text>)}</Card>} ListFooterComponent={rows.status === 'CanLoadMore' ? <Button label="Load more" variant="ghost" onPress={() => rows.loadMore(30)} /> : undefined} />;
}
