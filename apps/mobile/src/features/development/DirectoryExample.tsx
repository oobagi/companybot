import { useState } from 'react';
import { NavigationHeader, type HeaderAction } from '@/components/navigation/NavigationHeader';
import { Avatar, Button, Divider, EditorSheet, EmptyState, Field, ListRow, Screen, ScreenList } from '@/components/ui';
import { useDraftGuard } from '@/lib/useDraftGuard';

const initialItems = [
  { id: '1', title: 'Design library', description: 'Shared components and native interactions' },
  { id: '2', title: 'Project notes', description: 'A simple row with useful supporting text' },
  { id: '3', title: 'A longer title that should wrap naturally', description: 'Content determines row height, including at larger text sizes.' },
];

/** A copyable directory recipe: native header, one list, explicit creation. */
export function DirectoryExample({ menu }: { menu: HeaderAction[] }) {
  const [items, setItems] = useState(initialItems);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const filtered = items.filter(item => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <>
    <NavigationHeader search={{ placeholder: 'Search examples', value: search, onChange: setSearch }} action={{ label: 'New item', onPress: () => setCreating(true) }} menu={[
      { label: 'Clear search', onPress: () => setSearch('') },
      { label: items.length ? 'Show empty list' : 'Restore sample rows', onPress: () => { setSearch(''); setItems(items.length ? [] : initialItems); } },
      ...menu,
    ]} />
    <Screen nativeScroll padded={false}>
      <ScreenList data={filtered} keyExtractor={item => item.id} ItemSeparatorComponent={Divider} renderItem={({ item }) => <ListRow title={item.title} description={item.description} leading={<Avatar name={item.title} />} />}
        ListEmptyComponent={<EmptyState title={search.trim() ? 'No matching items' : 'No items yet'} description={search.trim() ? 'Try another search or clear your filter.' : 'Use the add button to create your first item.'} action={search.trim() ? <Button label="Clear search" variant="secondary" onPress={() => setSearch('')} /> : undefined} />} />
    </Screen>
    {creating && <NewItem onClose={() => setCreating(false)} onSave={title => { setItems(current => [...current, { id: String(Date.now()), title, description: 'Created locally in the component gallery' }]); setSearch(''); }} />}
  </>;
}

function NewItem({ onClose, onSave }: { onClose: () => void; onSave: (title: string) => void }) {
  const [title, setTitle] = useState('');
  const guard = useDraftGuard({ dirty: !!title, onClose });
  const save = () => {
    if (!title.trim()) return;
    onSave(title.trim());
    guard.complete();
    onClose();
  };
  return <EditorSheet title="New item" size="content" dismissible={guard.dismissible} onClose={() => void guard.close()}>
    {guard.dialog}
    <Field label="Title" value={title} onChangeText={setTitle} returnKeyType="done" onSubmitEditing={save} />
    <Button label="Create" disabled={!title.trim()} onPress={save} />
  </EditorSheet>;
}
