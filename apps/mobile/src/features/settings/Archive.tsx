import { can } from '@companybot/core/permissions';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { ActionMenu, Button, ConfirmSheet, Divider, EmptyState, ErrorState, ListRow, Loading, Screen, ScreenList } from '@/components/ui';
import { NavigationHeader } from '@/components/navigation/NavigationHeader';

export default function Archive() {
  const [search, setSearch] = useState('');
  const rows = usePaginatedQuery(api.trash.list, { search: search.trim() || undefined }, { initialNumItems: 30 });
  const me = useQuery(api.workspace.me);
  const restore = useMutation(api.trash.restore);
  const purge = useMutation(api.trash.purge);
  const task = useTask();
  const [deleting, setDeleting] = useState<{ id: string; name: string }>();
  const canDelete = !!me?.access && can(me.access, 'trash.manage');
  const unavailable = task.busy || !!deleting;
  const perform = (id: string, action: string) => {
    // A subscription can remove an item or revoke access while its menu is open.
    const item = rows.results.find(row => row._id === id);
    if (unavailable || !item) return;
    if (action === 'restore' && item.canRestore) void task.run(() => restore({ kind: item.kind, id: item.itemId }));
    else if (action === 'delete' && canDelete) { task.clear(); setDeleting({ id: item._id, name: item.name }); }
  };
  return <>
    <NavigationHeader search={{ placeholder: 'Search Archive', value: search, onChange: setSearch }} />
    <Screen nativeScroll padded={false}>
      <ScreenList data={rows.results} keyExtractor={item => item._id} ItemSeparatorComponent={Divider}
        ListHeaderComponent={task.error && !deleting ? <ErrorState message={task.error} layout="inline" /> : undefined}
        renderItem={({ item }) => <ListRow title={item.name} description={`${item.kind} · Archived by ${item.user} · ${new Date(item.at).toLocaleDateString()}${item.hasChildren ? ' · Includes sub-pages' : ''}`}
          trailing={item.canRestore || canDelete ? <ActionMenu label={`Actions for ${item.name}`} actions={[
            ...(item.canRestore ? [{ id: 'restore', title: 'Restore', icon: 'arrow.uturn.backward' as const, disabled: unavailable }] : []),
            ...(canDelete ? [{ id: 'delete', title: 'Delete forever', icon: 'trash' as const, destructive: true, disabled: unavailable }] : []),
          ]} onAction={action => perform(item._id, action)} /> : undefined} />}
        ListEmptyComponent={rows.status === 'LoadingFirstPage' ? <Loading /> : <EmptyState title={search.trim() ? 'No matches' : 'Archive is empty'} description={search.trim() ? 'Try another search or clear your filter.' : 'Archived items stay here until you restore them or an owner deletes them forever.'} action={search.trim() ? <Button label="Clear search" variant="secondary" onPress={() => setSearch('')} /> : undefined} />}
        ListFooterComponent={rows.status === 'CanLoadMore' ? <Button label="Load more" variant="ghost" onPress={() => rows.loadMore(30)} /> : rows.status === 'LoadingMore' ? <Loading layout="inline" /> : undefined} />
    </Screen>
    {deleting && <ConfirmSheet title={`Delete ${deleting.name} forever?`} message="This permanently deletes the item and its contents. You cannot undo this." confirmLabel="Delete forever" destructive busy={task.busy} error={task.error} onClose={() => setDeleting(undefined)} onConfirm={() => void task.run(async () => { await purge({ id: deleting.id }); setDeleting(undefined); })} />}
  </>;
}
