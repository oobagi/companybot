import { ReorderSheet } from '@/features/arrangements/ReorderSheet';
import { useArrangements } from '@/features/arrangements/useArrangements';
import { DirectoryHeader } from '@/features/session/DirectoryHeader';
import { useState } from 'react';
import { router } from 'expo-router';
import { can } from '@companybot/core/permissions';
import { EmptyState, ListRow, Loading, Screen, ScreenList } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { DatabaseForm } from './DatabaseForms';

export function DatabasesScreen() {
  const types = useQuery(api.recordTypes.list);
  const arrangements = useArrangements();
  const me = useQuery(api.workspace.me);
  const [organize, setOrganize] = useState(false);
  const [create, setCreate] = useState(false);
  const [search, setSearch] = useState('');
  const { spacing } = useTheme();
  return <><DirectoryHeader menu={arrangements.writable ? [{ label: 'Organize databases', onPress: () => setOrganize(true) }] : undefined} search={{ placeholder: 'Search databases', value: search, onChange: setSearch }} action={me?.access && can(me.access, 'fields.edit') ? { label: 'New database', onPress: () => setCreate(true) } : undefined} /><Screen nativeScroll padded={false} edges={['left', 'right']}>
    <ScreenList data={arrangements.order('databases', types ?? []).filter(type => type.plural.toLocaleLowerCase().includes(search.toLocaleLowerCase()))} keyExtractor={item => item._id} contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
      renderItem={({ item }) => <ListRow title={item.plural} description={`${item.fields.filter(f => !f.archived).length} fields`} onPress={() => router.push(`/database/${item._id}`)} />}
      ListEmptyComponent={types === undefined || !arrangements.loaded ? <Loading /> : <EmptyState title={search ? "No databases found" : "No databases yet"} description={search ? "Try a different name." : "Organize your team's records in a database."} />} />
    {organize && <ReorderSheet title="Organize databases" list="databases" items={(types ?? []).map(type => ({ _id: type._id, title: type.plural }))} loading={types === undefined} onClose={() => setOrganize(false)} />}
    {create && <DatabaseForm onClose={() => setCreate(false)} />}
  </Screen></>;
}
