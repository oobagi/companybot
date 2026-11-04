import { DirectoryHeader } from '@/components/navigation/DirectoryHeader';
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
  const me = useQuery(api.workspace.me);
  const [create, setCreate] = useState(false);
  const [search, setSearch] = useState('');
  const { spacing } = useTheme();
  return <><DirectoryHeader search={{ placeholder: 'Search databases', value: search, onChange: setSearch }} action={me?.role && can(me.role, 'fields.manage') ? { label: 'New database', onPress: () => setCreate(true) } : undefined} /><Screen nativeScroll padded={false} edges={['left', 'right']}>
    <ScreenList data={(types ?? []).filter(type => type.plural.toLocaleLowerCase().includes(search.toLocaleLowerCase()))} keyExtractor={item => item._id} contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
      renderItem={({ item }) => <ListRow title={item.plural} description={`${item.fields.filter(f => !f.archived).length} fields`} onPress={() => router.push(`/database/${item._id}`)} />}
      ListEmptyComponent={types === undefined ? <Loading /> : <EmptyState title={search ? "No databases found" : "No databases yet"} description={search ? "Try a different name." : "Organize your team's records in a database."} />} />
    {create && <DatabaseForm onClose={() => setCreate(false)} />}
  </Screen></>;
}
