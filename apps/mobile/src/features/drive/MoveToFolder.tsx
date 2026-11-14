import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Button, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Text } from '@/components/ui';
import { useArrangements } from '@/features/arrangements/useArrangements';
import { api } from '@/lib/api';
import { usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';

/** Picks a folder (or the top level) for a page, folder or file, then runs `onMove`. */
export function MoveToFolder({ title, noun, itemId, parentId, editable, onMove, onClose }: {
  title: string; noun: 'page' | 'folder' | 'file'; itemId: string; parentId: Id<'pages'> | null; editable: boolean;
  onMove: (parentId: Id<'pages'> | undefined) => Promise<unknown>; onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const searching = !!search.trim();
  const matches = useQuery(api.pages.search, searching ? { query: search.trim() } : 'skip');
  const roots = usePaginatedQuery(api.pages.children, {}, { initialNumItems: 30 });
  const arrangements = useArrangements();
  const task = useTask();
  const loading = searching ? matches === undefined : roots.status === 'LoadingFirstPage';
  const destinations = (searching ? matches ?? [] : arrangements.order('pages', roots.results))
    .filter(row => row._id !== itemId && row.kind === 'folder');
  const choose = (target?: Id<'pages'>) => {
    if (!editable || task.busy || target === (parentId ?? undefined)) return;
    if (target && !destinations.some(row => row._id === target && row.canEdit)) return;
    void task.run(async () => { await onMove(target); onClose(); });
  };
  return <EditorSheet title={title} scroll={false} busy={task.busy} onClose={onClose}>
    <Text tone="muted">{noun === 'file' ? 'Choose a folder for this file.' : `Choose a folder. Everything inside moves with this ${noun}.`}</Text>
    {!editable && <Text tone="muted">This {noun} is read only and cannot be moved.</Text>}
    <Field label="Find destination" value={search} onChangeText={setSearch} editable={editable && !task.busy} autoCorrect={false} />
    {task.error && <ErrorState message={task.error} />}
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ flexGrow: 1 }}>
      <ListRow title="Top level" selected={!parentId} disabled={!editable || task.busy || !parentId} onPress={() => choose()} />
      {loading ? <Loading label="Loading destinations…" /> : destinations.map(row => <ListRow key={row._id} title={row.title || 'Untitled'} description={'path' in row ? row.path.join(' / ') : undefined} selected={row._id === parentId} disabled={!editable || task.busy || row._id === parentId || !row.canEdit} onPress={() => choose(row._id)} />)}
      {!loading && !destinations.length && <EmptyState title={searching ? 'No matching destinations' : 'No destinations yet'} description="Try searching for a folder, or move to the top level." />}
      {!searching && (roots.status === 'CanLoadMore' || roots.status === 'LoadingMore') && <Button label="More destinations" variant="ghost" disabled={!editable || task.busy} loading={roots.status === 'LoadingMore'} onPress={() => roots.loadMore(30)} />}
    </ScrollView>
  </EditorSheet>;
}
