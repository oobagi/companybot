import { useState } from 'react';
import { FlatList } from 'react-native';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { Button, Card, ConfirmSheet, EmptyState, ErrorState, Field, Loading, Screen, Stack, Text } from '@/components/ui';

export default function Archive() {
  const [search, setSearch] = useState('');
  const rows = usePaginatedQuery(api.trash.list, { search: search.trim() || undefined }, { initialNumItems: 30 });
  const me = useQuery(api.workspace.me);
  const restore = useMutation(api.trash.restore);
  const purge = useMutation(api.trash.purge);
  const task = useTask();
  const [deleting, setDeleting] = useState<{ id: string; name: string }>();
  return <Screen><Stack style={{ flex: 1 }}><Field label="Search Archive" value={search} onChangeText={setSearch} />{task.error && !deleting && <ErrorState message={task.error} />}<Text tone="muted" variant="caption">Archived items stay here until you restore them or an owner deletes them forever.</Text>
  <FlatList data={rows.results} keyExtractor={r => r._id} contentContainerStyle={{ flexGrow: 1, gap: 12 }} renderItem={({ item }) => <Card><Text variant="label">{item.name}</Text><Text tone="muted" variant="caption">{item.kind} · Archived by {item.user} · {new Date(item.at).toLocaleDateString()}</Text>{item.hasChildren && <Text tone="muted">Includes sub-pages.</Text>}{item.canRestore && <Button label="Restore" variant="secondary" disabled={task.busy} onPress={() => void task.run(() => restore({ kind: item.kind, id: item.itemId }))} />}{me?.role === 'owner' && <Button label="Delete forever" variant="danger" disabled={task.busy} onPress={() => { task.clear(); setDeleting({ id: item._id, name: item.name }); }} />}</Card>} ListEmptyComponent={rows.status === 'LoadingFirstPage' ? <Loading /> : <EmptyState title={search ? 'No matches' : 'Archive is empty'} />} ListFooterComponent={rows.status === 'CanLoadMore' ? <Button label="Load more" variant="ghost" onPress={() => rows.loadMore(30)} /> : rows.status === 'LoadingMore' ? <Loading layout="inline" /> : undefined} /></Stack>
  {deleting && <ConfirmSheet title={`Delete ${deleting.name} forever?`} message="This permanently deletes the item and its contents. You cannot undo this." confirmLabel="Delete forever" destructive busy={task.busy} error={task.error} onClose={() => setDeleting(undefined)} onConfirm={() => void task.run(async () => { await purge({ id: deleting.id }); setDeleting(undefined); })} />}</Screen>;
}
