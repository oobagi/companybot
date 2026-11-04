import { Platform } from 'react-native';
import { applyCommand } from '@companybot/core/arrangements';
import type { OptimisticUpdate } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { Button, EditorSheet, EmptyState, ErrorState, Loading, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { useArrangements } from './useArrangements';
import { moveCommands } from './move';
import { ReorderList } from './ReorderList';
import type { ReorderItem } from './ReorderList.types';

const optimisticMove: OptimisticUpdate<FunctionArgs<typeof api.arrangements.change>> = (store, { workspaceId, list, entityId, command }) => {
  for (const query of store.getAllQueries(api.arrangements.get)) {
    if (query.args.workspaceId !== workspaceId || !query.value) continue;
    const previous = query.value.rows.find(row => row.list === list && row.entityId === entityId);
    store.setQuery(api.arrangements.get, query.args, { ...query.value, rows: [...query.value.rows.filter(row => row !== previous), { list, entityId, ids: applyCommand(previous?.ids, command) }] });
  }
};

export function ReorderSheet({ title, list, entityId, items, currentId, loading = false, complete = true, loadingMore = false, onLoadMore, onClose }: {
  title: string; list: 'channels' | 'databases' | 'pages' | 'views'; entityId?: string; items: ReorderItem[]; currentId?: string;
  loading?: boolean; complete?: boolean; loadingMore?: boolean; onLoadMore?: () => void; onClose: () => void;
}) {
  const arrangements = useArrangements();
  const change = useMutation(api.arrangements.change, optimisticMove);
  const task = useTask();
  const guard = useDraftGuard({ dirty: false, busy: task.busy, onClose });
  const shown = arrangements.order(list, items, entityId);
  const saved = arrangements.rows.find(row => row.list === list && row.entityId === entityId)?.ids ?? [];
  const move = (sources: number[], destination: number) => {
    if (!arrangements.writable || task.busy || loadingMore) return;
    void task.run(async () => { for (const command of moveCommands(saved, shown.map(item => item._id), sources, destination, complete)) await change({ list, entityId, command }); });
  };
  return <EditorSheet title={title} scroll={false} busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>
    {guard.dialog}
    <Text variant="caption" tone="muted">{Platform.OS === 'ios' ? 'Drag the handles to reorder.' : 'Use each row’s Move menu to reorder.'} Changes are shared and saved immediately.</Text>
    {!arrangements.writable && arrangements.loaded && <Text tone="muted">Your role cannot organize shared lists.</Text>}
    {task.error && <ErrorState message={task.error} />}
    {task.busy && <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">Saving order…</Text>}
    {loading || !arrangements.loaded ? <Loading /> : !shown.length ? <EmptyState title="Nothing to organize" /> : <ReorderList items={shown} currentId={currentId} complete={complete} disabled={!arrangements.writable || task.busy || loadingMore} onMove={move} />}
    {!complete && <Text variant="caption" tone="muted">Showing {shown.length} loaded pages. Load all pages to move an item to the end.</Text>}
    {onLoadMore && !complete && <Button label="Load more pages" variant="secondary" loading={loadingMore} disabled={task.busy} onPress={onLoadMore} />}
  </EditorSheet>;
}
