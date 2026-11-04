import { useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { router, Stack as RouterStack } from 'expo-router';
import { DirectoryHeader } from '@/components/navigation/DirectoryHeader';
import { Badge, Button, EmptyState, ErrorState, ListRow, Loading, Screen, ScreenList, Stack, Text } from '@/components/ui';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { OverlayChromeContext } from '@/components/ui/scrollViewport';
import { useTheme } from '@/design';
import { useTask } from '@/lib/useTask';
import { usePinAction, usePins } from './usePins';
import { usePinEntries } from './usePinEntries';
import type { PinEntry } from './model';

const PAGE_SIZE = 50;

export function SavedScreen() {
  const { pins, recent, loaded, change } = usePins();
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const all = useMemo(() => [...pins, ...recent], [pins, recent]);
  const keys = useMemo(() => all.slice(0, limit), [all, limit]);
  const { entries, loading, error } = usePinEntries(keys);
  const task = useTask();
  const { spacing } = useTheme();
  const matches = entries.filter(entry => `${entry.title} ${entry.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const rows = matches.map((entry, index) => ({ ...entry, section: index === 0 || pins.includes(entry.key) !== pins.includes(matches[index - 1].key) ? pins.includes(entry.key) ? 'Pinned' : 'Recent' : undefined }));
  const more = keys.length < all.length;
  // iOS keeps this search-header route's scroll frame behind native chrome even
  // in the root stack. Account for its measured header when filling empty content.
  return <OverlayChromeContext.Provider value={Platform.OS === 'ios'}><Screen nativeScroll padded={false}>
    <RouterStack.Screen options={{ title: 'Pinned and recent' }} />
    <DirectoryHeader workspaceSwitcher={false} search={{ placeholder: 'Search saved items', value: search, onChange: setSearch }} />
    <ScreenList data={rows} keyExtractor={row => row.key} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
      ListHeaderComponent={error || task.error ? <ErrorState message={task.error ?? error!} /> : undefined}
      renderItem={({ item }) => {
        const index = pins.indexOf(item.key);
        const move = (direction: -1 | 1) => void task.run(() => change({ list: 'pinsOrder', command: { op: 'move', id: item.key, beforeId: direction < 0 ? pins[index - 1] : pins[index + 2] ?? null, fill: pins } }));
        return <Stack gap="xs">{item.section && <Text variant="label" tone="muted" style={{ paddingTop: spacing.md }}>{item.section}</Text>}<SavedRow entry={item} busy={task.busy} onUp={index > 0 ? () => move(-1) : undefined} onDown={index >= 0 && index < pins.length - 1 ? () => move(1) : undefined} /></Stack>;
      }}
      ListEmptyComponent={!loaded || loading ? <Loading label="Loading saved items…" /> : <EmptyState title={search.trim() ? 'No matches' : 'Nothing saved yet'} description={search.trim() ? 'Try another name or load more saved items.' : 'Pin a conversation, page, database or record from its menu. Items you open also appear here.'} />}
      ListFooterComponent={more || (loading && matches.length > 0) ? <Stack gap="sm">{loading && matches.length > 0 && <Loading layout="inline" label="Loading saved items…" />}{more && <><Text variant="caption" tone="muted">Loaded {keys.length} of {all.length} saved items. Search includes loaded items.</Text><Button label="Load more saved items" variant="ghost" onPress={() => setLimit(value => value + PAGE_SIZE)} /></>}</Stack> : undefined} />
  </Screen></OverlayChromeContext.Provider>;
}

function SavedRow({ entry, busy, onUp, onDown }: { entry: PinEntry; busy: boolean; onUp?: () => void; onDown?: () => void }) {
  const pin = usePinAction(entry.key);
  return <Stack gap="xs"><ListRow title={entry.title} description={entry.description} onPress={() => router.push(entry.path)} trailing={<Stack horizontal gap="xs">{entry.mentioned ? <Badge label="Mention" /> : entry.unread ? <Badge label="Unread" /> : null}<ActionMenu label={`Actions for ${entry.title}`} actions={[
    { id: 'pin', title: pin.label, disabled: pin.disabled || busy },
    ...(onUp ? [{ id: 'up', title: 'Move up', disabled: busy }] : []),
    ...(onDown ? [{ id: 'down', title: 'Move down', disabled: busy }] : []),
  ]} onAction={action => { if (action === 'pin') pin.onPress(); else if (action === 'up') onUp?.(); else if (action === 'down') onDown?.(); }} /></Stack>} />{pin.error && <ErrorState message={pin.error} />}</Stack>;
}
