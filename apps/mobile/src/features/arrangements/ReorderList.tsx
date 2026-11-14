import { useRef } from 'react';
import { FlatList } from 'react-native';
import { ListRow, Text } from '@/components/ui';
import { ActionMenu } from '@/components/ui/ActionMenu';
import type { ReorderItem, ReorderListProps } from './ReorderList.types';

/** Android uses the system menu; Expo's Compose list currently has no drag-reorder API. */
export function ReorderList({ items, disabled, complete, currentId, onMove }: ReorderListProps) {
  const list = useRef<FlatList<ReorderItem>>(null);
  const positioned = useRef(false);
  const currentIndex = items.findIndex(item => item._id === currentId);
  return <FlatList ref={list} data={items} keyExtractor={item => item._id} style={{ flex: 1 }} initialNumToRender={Math.max(16, currentIndex + 1)}
    onContentSizeChange={() => { if (!positioned.current && currentIndex >= 0) { positioned.current = true; list.current?.scrollToIndex({ index: currentIndex, animated: false, viewPosition: 0.5 }); } }}
    onScrollToIndexFailed={({ averageItemLength, index }) => list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false })}
    renderItem={({ item, index }) => <ListRow title={item.title} description={item._id === currentId ? 'Current view' : undefined} trailing={<ActionMenu label={`Move ${item.title}`} actions={[
      { id: 'up', title: 'Move up', disabled: disabled || index === 0 },
      { id: 'down', title: 'Move down', disabled: disabled || index === items.length - 1 || (!complete && index === items.length - 2) },
      { id: 'first', title: 'Move to beginning', disabled: disabled || index === 0 },
      { id: 'last', title: 'Move to end', disabled: disabled || !complete || index === items.length - 1 },
    ]} onAction={action => { if (!disabled) onMove([index], action === 'up' ? index - 1 : action === 'down' ? index + 2 : action === 'first' ? 0 : items.length); }}><Text tone="link">Move</Text></ActionMenu>} />} />;
}
