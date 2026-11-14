import { useState } from 'react';
import { ChoicePicker, EmptyState, Field, ListRow, Loading } from '@/components/ui';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { Dialog } from './Dialog';
import type { Mention } from './logic';

const label = (name: string) => name.replace(/[\[\]\\]/g, '').replace(/\s+/g, ' ');
export function MentionPicker({ directory, onPick, onClose }: { directory: Mention[]; onPick: (text: string, mention?: Mention) => void; onClose: () => void }) {
  const [kind, setKind] = useState('people');
  const [query, setQuery] = useState('');
  const chats = useQuery(api.chats.list, kind === 'channels' ? {} : 'skip');
  const browse = useQuery(api.chats.browse, kind === 'channels' ? {} : 'skip');
  const records = useQuery(api.records.search, kind === 'records' && query.trim() ? { query: query.trim() } : 'skip');
  const types = useQuery(api.recordTypes.list, kind === 'records' ? {} : 'skip');
  const matches = (name: string) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const people = directory.filter((p) => (kind === 'skills' ? p.kind === 'skill' : p.kind !== 'skill') && matches(p.name));
  const channels = [...new Map([...(chats?.channels ?? []), ...(browse ?? [])].map(channel => [channel._id, channel])).values()].filter((c) => matches(c.name ?? ''));
  return <Dialog title="Mention or link" onClose={onClose}>
    <ChoicePicker label="Choose from" value={kind} options={[{ value: 'people', label: 'People and agents' }, { value: 'skills', label: 'Skills' }, { value: 'channels', label: 'Channels' }, { value: 'records', label: 'Records' }]} onChange={(value) => { if (typeof value === 'string' && value) { setKind(value); setQuery(''); } }} />
    <Field label={kind === 'records' ? 'Search records' : 'Search'} value={query} onChangeText={setQuery} autoCorrect={false} />
    {kind === 'people' || kind === 'skills' ? people.length ? people.map((p) => <ListRow key={`${p.kind}:${p.id}`} title={`${p.kind === 'skill' ? '/' : '@'}${p.name}`} description={p.detail || p.kind} onPress={() => onPick(`${p.kind === 'skill' ? '/' : '@'}${p.name}`, p)} />) : <EmptyState title="No matches" /> : null}
    {kind === 'channels' && (chats === undefined || browse === undefined ? <Loading /> : channels.length ? channels.map((channel) => <ListRow key={channel._id} title={`#${channel.name}`} description={channel.topic ?? undefined} onPress={() => onPick(`[#${label(channel.name ?? '')}](#/chat/${channel._id})`)} />) : <EmptyState title="No matching channels" />)}
    {kind === 'records' && (!query.trim() ? <EmptyState title="Find a record" description="Search by name to link a record in your message." /> : records === undefined ? <Loading /> : records.length ? records.map((record) => <ListRow key={record._id} title={record.title} description={types?.find((type) => type._id === record.typeId)?.plural} onPress={() => onPick(`[${label(record.title)}](#/records/${types?.find((type) => type._id === record.typeId)?.key ?? 'record'}/${record._id})`)} />) : <EmptyState title="No matching records" />)}
  </Dialog>;
}
