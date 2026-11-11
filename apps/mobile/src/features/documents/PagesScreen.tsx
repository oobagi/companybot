import { ReorderSheet } from '@/features/arrangements/ReorderSheet';
import { useArrangements } from '@/features/arrangements/useArrangements';
import { DirectoryHeader } from '@/features/session/DirectoryHeader';
import { can } from '@companybot/core/permissions';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { router } from 'expo-router';
import { useState } from 'react';
import { PageIcon, FolderIcon } from '@/design/icons';
import { Button, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Stack, listContentStyle } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';

export function openPage(pageId: string) { router.push({ pathname: '/pages/[pageId]', params: { pageId } }); }

export function PagesScreen() {
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [organize, setOrganize] = useState(false);
  const arrangements = useArrangements();
  const me = useQuery(api.workspace.me);
  const found = useQuery(api.pages.search, search.trim() ? { query: search.trim() } : 'skip');
  const theme = useTheme();
  return <><DirectoryHeader menu={arrangements.writable ? [{ label: 'Organize pages', icon: 'arrow.up.arrow.down', onPress: () => setOrganize(true) }] : undefined} search={{ placeholder: 'Search pages', value: search, onChange: setSearch }} action={me?.access && can(me.access, 'pages.edit') ? { label: 'New page', onPress: () => setCreating(true) } : undefined} /><Screen keyboard nativeScroll padded={false} edges={['left', 'right']}><Stack style={{ flex: 1 }}>
    {search.trim() ? <ScreenList contentContainerStyle={listContentStyle} data={found ?? []} keyboardShouldPersistTaps="handled" keyExtractor={(page) => page._id}
      renderItem={({ item }) => <ListRow title={item.title || 'Untitled'} description={item.path.join(' / ') || 'Top level'} leading={item.kind === 'folder' ? <FolderIcon size={theme.sizes.icon} color={theme.colors.muted} /> : <PageIcon size={theme.sizes.icon} color={theme.colors.muted} />} onPress={() => openPage(item._id)} />}
      ListEmptyComponent={found === undefined ? <Loading /> : <EmptyState title="No pages found" description="Try a different title." />} /> : <PageChildren />}
    {organize && <PageOrganizer onClose={() => setOrganize(false)} />}
    {creating && <NewPage onClose={() => setCreating(false)} />}
  </Stack></Screen></>;
}

export function PageChildren({ parentId, onSelect = openPage }: { parentId?: Id<'pages'>; onSelect?: (id: Id<'pages'>) => void }) {
  const pages = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
  const arrangements = useArrangements();
  const theme = useTheme();
  return <ScreenList contentContainerStyle={listContentStyle} data={arrangements.order('pages', pages.results, parentId)} keyboardShouldPersistTaps="handled" keyExtractor={(page) => page._id}
    renderItem={({ item }) => <ListRow title={item.title || 'Untitled'} description={item.hasChildren ? 'Contains sub-pages' : undefined} leading={item.kind === 'folder' ? <FolderIcon size={theme.sizes.icon} color={theme.colors.muted} /> : <PageIcon size={theme.sizes.icon} color={theme.colors.muted} />} disclosure onPress={() => onSelect(item._id)} />}
    ListEmptyComponent={pages.status === 'LoadingFirstPage' || !arrangements.loaded ? <Loading /> : <EmptyState title={parentId ? 'No sub-pages' : 'No pages yet'} description={parentId ? 'Create a page inside this one to organize your work.' : 'Keep notes, plans and team knowledge together.'} />}
    ListFooterComponent={pages.status === 'CanLoadMore' || pages.status === 'LoadingMore' ? <Button label="Load more pages" variant="ghost" loading={pages.status === 'LoadingMore'} onPress={() => pages.loadMore(30)} /> : undefined} />;
}

export function NewPage({ parentId, onClose }: { parentId?: Id<'pages'>; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [created, setCreated] = useState<Id<'pages'>>();
  const create = useMutation(api.pages.create);
  const task = useTask();
  const busy = task.busy || !!created;
  const guard = useDraftGuard({ dirty: !!title, busy, onClose });
  const save = () => { if (!busy) void task.run(async () => { const id = await create({ title: title.trim() || 'Untitled', parentId }); guard.complete(); setCreated(id); }); };
  return <EditorSheet size="content" title={parentId ? 'New sub-page' : 'New page'} open={!created} onDismiss={() => { if (created) { onClose(); openPage(created); } }} busy={busy} dismissible={guard.dismissible} onClose={() => void guard.close()} submit={{ label: 'Create', disabled: busy, onPress: save }}>
    {guard.dialog}
    <Field label="Title" value={title} onChangeText={setTitle} editable={!busy} autoFocus placeholder="Untitled" />
    {task.error && <ErrorState message={task.error} />}
  </EditorSheet>;
}

/** A dedicated paginated subscription avoids treating a search result as the complete sibling list. */
export function PageOrganizer({ parentId, onClose }: { parentId?: Id<'pages'>; onClose: () => void }) {
  const pages = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
  return <ReorderSheet title={parentId ? 'Organize sub-pages' : 'Organize pages'} list="pages" entityId={parentId}
    items={pages.results.map(page => ({ _id: page._id, title: page.title || 'Untitled' }))} loading={pages.status === 'LoadingFirstPage'}
    complete={pages.status === 'Exhausted'} loadingMore={pages.status === 'LoadingMore'} onLoadMore={() => pages.loadMore(30)} onClose={onClose} />;
}
