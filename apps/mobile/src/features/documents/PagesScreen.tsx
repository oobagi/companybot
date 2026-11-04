import { useArrangements } from '@/features/arrangements/useArrangements';
import { DirectoryHeader } from '@/components/navigation/DirectoryHeader';
import { can } from '@companybot/core/permissions';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { router } from 'expo-router';
import { useState } from 'react';
import { FileText } from 'phosphor-react-native';
import { Button, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';

export function openPage(pageId: string) { router.push({ pathname: '/pages/[pageId]', params: { pageId } }); }

export function PagesScreen() {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const me = useQuery(api.workspace.me);
  const found = useQuery(api.pages.search, search.trim() ? { query: search.trim() } : 'skip');
  const theme = useTheme();
  return <><DirectoryHeader search={{ placeholder: 'Search pages', value: search, onChange: setSearch }} action={me?.access && can(me.access, 'pages.edit') ? { label: 'New page', onPress: () => setCreating(true) } : undefined} /><Screen nativeScroll padded={false} edges={['left', 'right']}><Stack style={{ flex: 1 }}>
    {search.trim() ? <ScreenList contentContainerStyle={{ paddingHorizontal: theme.spacing.lg }} data={found ?? []} keyboardShouldPersistTaps="handled" keyExtractor={(page) => page._id}
      renderItem={({ item }) => <ListRow title={item.title || 'Untitled'} description={item.path.join(' / ') || 'Top level'} leading={<FileText size={theme.sizes.icon} color={theme.colors.muted} />} onPress={() => openPage(item._id)} />}
      ListEmptyComponent={found === undefined ? <Loading /> : <EmptyState title="No pages found" description="Try a different title." />} /> : <PageChildren />}
    {creating && <NewPage onClose={() => setCreating(false)} />}
  </Stack></Screen></>;
}

export function PageChildren({ parentId, onSelect = openPage }: { parentId?: Id<'pages'>; onSelect?: (id: Id<'pages'>) => void }) {
  const pages = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
  const arrangements = useArrangements();
  const theme = useTheme();
  return <ScreenList contentContainerStyle={{ paddingHorizontal: theme.spacing.lg }} data={arrangements.order('pages', pages.results, parentId)} keyboardShouldPersistTaps="handled" keyExtractor={(page) => page._id}
    renderItem={({ item }) => <ListRow title={item.title || 'Untitled'} description={item.hasChildren ? 'Contains sub-pages' : undefined} leading={<FileText size={theme.sizes.icon} color={theme.colors.muted} />} trailing={<Text tone="muted">›</Text>} onPress={() => onSelect(item._id)} />}
    ListEmptyComponent={pages.status === 'LoadingFirstPage' || !arrangements.loaded ? <Loading /> : <EmptyState title={parentId ? 'No sub-pages' : 'No pages yet'} description={parentId ? 'Create a page inside this one to organize your work.' : 'Keep notes, plans and team knowledge together.'} />}
    ListFooterComponent={pages.status === 'CanLoadMore' || pages.status === 'LoadingMore' ? <Button label="Load more pages" variant="ghost" loading={pages.status === 'LoadingMore'} onPress={() => pages.loadMore(30)} /> : undefined} />;
}

export function NewPage({ parentId, onClose }: { parentId?: Id<'pages'>; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const create = useMutation(api.pages.create);
  const task = useTask();
  const guard = useDraftGuard({ dirty: !!title, busy: task.busy, onClose });
  return <EditorSheet size="content" title={parentId ? 'New sub-page' : 'New page'} busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>
    {guard.dialog}
    <Field label="Title" value={title} onChangeText={setTitle} autoFocus placeholder="Untitled" />
    {task.error && <ErrorState message={task.error} />}
    <Button label="Create page" loading={task.busy} onPress={() => void task.run(async () => {
      const id = await create({ title: title.trim() || 'Untitled', parentId }); onClose(); openPage(id);
    })} />
  </EditorSheet>;
}
