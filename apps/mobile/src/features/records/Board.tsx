import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { Button, ChoicePicker, EmptyState, ErrorState, Loading, Stack, Text } from '@/components/ui';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { RecordCard } from './RecordCard';
import { boardLanes, boardMove, boardQuery, type BoardLane } from './boardModel';
import type { Database, TypeField, ViewConfig } from './model';

type BoardProps = { database: Database; config: ViewConfig; group: TypeField };

export function Board({ database, config, group }: BoardProps) {
  const { spacing } = useTheme();
  const list = useRef<FlatList<BoardLane>>(null);
  const [width, setWidth] = useState(0);
  const [currentId, setCurrentId] = useState('');
  const [retired, setRetired] = useState<Record<string, boolean>>({});
  const [scan, setScan] = useState(0);
  const all = boardLanes(group);
  const lanes = all.filter(lane => !lane.retired || retired[lane.id]);
  const current = Math.max(0, lanes.findIndex(lane => lane.id === currentId));
  const currentIndex = useRef(current);
  useEffect(() => { currentIndex.current = current; }, [current]);
  const laneIds = lanes.map(lane => lane.id).join('|');
  const reportRetired = useCallback((id: string, present: boolean) => setRetired(previous => previous[id] === present ? previous : { ...previous, [id]: present }), []);
  const laneWidth = Math.max(1, width - spacing.lg * 2 - spacing.xl);
  const step = laneWidth + spacing.md;
  const update = useMutation(api.records.update);
  const task = useTask();
  const move = (recordId: Id<'records'>, from: string, to: string) => {
    const values = boardMove(database.canEdit, group, from, to);
    if (values) void task.run(() => update({ recordId, values }));
  };
  // Keep the selected column aligned after rotation or retired-column discovery.
  useEffect(() => { if (width) list.current?.scrollToOffset({ offset: currentIndex.current * step, animated: false }); }, [laneIds, step, width]);
  return <View style={{ flex: 1 }} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <Stack gap="xs" style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
      <ChoicePicker label={`Column ${current + 1} of ${lanes.length}`} value={lanes[current]?.id || '__empty'} options={lanes.map(lane => ({ value: lane.id || '__empty', label: lane.label }))} onChange={value => {
        if (typeof value !== 'string') return;
        const id = value === '__empty' ? '' : value;
        const index = lanes.findIndex(lane => lane.id === id);
        if (index >= 0) { setCurrentId(id); list.current?.scrollToOffset({ offset: index * step, animated: false }); }
      }} />
      {task.error && <ErrorState message={task.error} />}
      {!!all.filter(lane => lane.retired).length && <RetiredColumns key={scan} database={database} config={config} group={group} lanes={all.filter(lane => lane.retired)} onResult={reportRetired} onRefresh={() => setScan(value => value + 1)} />}
    </Stack>
    {!!width && <FlatList ref={list} horizontal data={lanes} keyExtractor={lane => lane.id || '__empty'} style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.md }} contentInsetAdjustmentBehavior="never"
      showsHorizontalScrollIndicator={false} snapToInterval={step} snapToAlignment="start" decelerationRate="fast" disableIntervalMomentum
      initialNumToRender={2} maxToRenderPerBatch={2} windowSize={3} getItemLayout={(_, index) => ({ length: step, offset: step * index, index })}
      onScroll={event => { const index = Math.max(0, Math.min(lanes.length - 1, Math.round(event.nativeEvent.contentOffset.x / step))); const lane = lanes[index]; if (lane && lane.id !== currentId) setCurrentId(lane.id); }} scrollEventThrottle={32}
      renderItem={({ item, index }) => <View style={{ width: laneWidth, height: '100%' }}>
        {Math.abs(index - current) <= 1 ? <Lane database={database} config={config} group={group} lane={item} destinations={all.filter(lane => !lane.retired)} busy={task.busy} onMove={move} onRetired={reportRetired} /> : null}
      </View>} />}
  </View>;
}

function Lane({ database, config, group, lane, destinations, busy, onMove, onRetired }: BoardProps & {
  lane: BoardLane; destinations: BoardLane[]; busy: boolean; onMove: (id: Id<'records'>, from: string, to: string) => void; onRetired: (id: string, present: boolean) => void;
}) {
  const { colors, radii, spacing } = useTheme();
  const { results, status, loadMore } = usePaginatedQuery(api.records.list, boardQuery(database._id, config, group, lane.id), { initialNumItems: 25 });
  const missing = [...new Set(results.flatMap(record => record.unresolved))].slice(0, 200);
  const refs = useQuery(api.records.refs, missing.length ? { ids: missing } : 'skip');
  const cards = { ...config, columns: config.columns.filter(key => key !== group.key) };
  useEffect(() => { if (lane.retired && status === 'Exhausted') onRetired(lane.id, results.length > 0); }, [lane.id, lane.retired, status, results.length, onRetired]);
  return <View style={{ flex: 1, backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.sm }}>
    <Stack horizontal gap="sm" style={{ padding: spacing.sm }}>
      <Text variant="label" accessibilityRole="header" style={{ flex: 1 }}>{lane.label}</Text>
      {status !== 'LoadingFirstPage' && <Text variant="caption" tone="muted" accessibilityLabel={`${results.length} loaded records${status === 'Exhausted' ? '' : ', more available'}`}>{results.length}{status === 'Exhausted' ? '' : '+'}</Text>}
    </Stack>
    <FlatList data={results} keyExtractor={record => record._id} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, gap: spacing.sm, paddingBottom: spacing.md }} contentInsetAdjustmentBehavior="never"
      nestedScrollEnabled keyboardShouldPersistTaps="handled" initialNumToRender={8} maxToRenderPerBatch={8} windowSize={5}
      renderItem={({ item }) => <RecordCard row={item} database={database} config={cards} refs={{ ...item.refs, ...refs }} action={database.canEdit && !item.archived ? <ActionMenu label={`Move ${item.title} to column`} actions={destinations.map(destination => ({ id: destination.id || '__empty', title: destination.label, disabled: busy || destination.id === lane.id, selected: destination.id === lane.id }))} onAction={destination => onMove(item._id, lane.id, destination === '__empty' ? '' : destination)}><Text variant="caption" tone="link">Move</Text></ActionMenu> : undefined} />}
      ListEmptyComponent={status === 'LoadingFirstPage' ? <Loading label={`Loading ${lane.label}…`} /> : status === 'Exhausted' ? <EmptyState layout="inline" title={`No records in ${lane.label}`} description={config.filters.length ? 'No records in this column match the view’s filters.' : 'Records with this value appear here.'} /> : <Text tone="muted" style={{ padding: spacing.md }}>No matches in the loaded pages. Continue loading to check this column.</Text>}
      ListFooterComponent={status === 'CanLoadMore' || status === 'LoadingMore' ? <Button label={`Load more in ${lane.label}`} variant="ghost" loading={status === 'LoadingMore'} onPress={() => loadMore(25)} /> : undefined} />
  </View>;
}

/** Scan removed options serially: one bounded query, never one subscription per field option. */
function RetiredColumns({ lanes, onResult, onRefresh, ...props }: BoardProps & { lanes: BoardLane[]; onResult: (id: string, present: boolean) => void; onRefresh: () => void }) {
  const [index, setIndex] = useState(0);
  const done = useCallback((id: string, present: boolean) => { onResult(id, present); setIndex(value => value + 1); }, [onResult]);
  const lane = lanes[index];
  return lane ? <RetiredProbe key={lane.id} {...props} lane={lane} onResult={done} /> : <Stack gap="xs"><Text variant="caption" tone="muted">Removed columns are checked on open or refresh.</Text><Button label="Refresh removed columns" variant="ghost" onPress={onRefresh} /></Stack>;
}

function RetiredProbe({ database, config, group, lane, onResult }: BoardProps & { lane: BoardLane; onResult: (id: string, present: boolean) => void }) {
  const { results, status, loadMore } = usePaginatedQuery(api.records.list, boardQuery(database._id, config, group, lane.id), { initialNumItems: 1 });
  const reported = useRef(false);
  useEffect(() => { if (!reported.current && (results.length > 0 || status === 'Exhausted')) { reported.current = true; onResult(lane.id, results.length > 0); } }, [lane.id, results.length, status, onResult]);
  return status === 'CanLoadMore' ? <Button label="Continue checking removed columns" variant="ghost" onPress={() => loadMore(25)} /> : <Loading layout="inline" label="Checking removed columns…" />;
}
