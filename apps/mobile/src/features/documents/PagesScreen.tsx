import { ReorderSheet } from '@/features/arrangements/ReorderSheet';
import { useArrangements } from '@/features/arrangements/useArrangements';
import { DirectoryHeader } from '@/features/session/DirectoryHeader';
import { DriveList, pickFiles, useDriveLevel } from '@/features/drive/DriveListing';
import { useDriveUploads } from '@/features/drive/uploads';
import type { HeaderAction } from '@/components/navigation/NavigationHeader';
import { can } from '@companybot/core/permissions';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { router } from 'expo-router';
import { useState } from 'react';
import { PageIcon, FolderIcon } from '@/design/icons';
import { EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, ScreenList, Stack, listContentStyle } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';

export function openPage(pageId: string) { router.push({ pathname: '/pages/[pageId]', params: { pageId } }); }

/** The New menu for a Drive level (the top, or a folder): a page, a folder, or files from the device. */
export function useDriveNew(parentId: Id<'pages'> | undefined, start: (files: Awaited<ReturnType<typeof pickFiles>>) => void) {
  const [creating, setCreating] = useState<'page' | 'folder'>();
  const task = useTask();
  const items: HeaderAction[] = [
    { label: 'New page', icon: 'doc.text', onPress: () => setCreating('page') },
    { label: 'New folder', icon: 'folder', onPress: () => setCreating('folder') },
    { label: 'Upload files', icon: 'square.and.arrow.up', onPress: () => void task.run(async () => start(await pickFiles())) },
  ];
  const sheet = creating && <NewPage parentId={parentId} kind={creating} onClose={() => setCreating(undefined)} />;
  return { items, sheet, error: task.error };
}

export function PagesScreen() {
  const [search, setSearch] = useState('');
  const [organize, setOrganize] = useState(false);
  const arrangements = useArrangements();
  const me = useQuery(api.workspace.me);
  const found = useQuery(api.pages.search, search.trim() ? { query: search.trim() } : 'skip');
  const uploads = useDriveUploads();
  const canEdit = !!me?.access && can(me.access, 'pages.edit');
  const create = useDriveNew(undefined, uploads.start);
  const theme = useTheme();
  return <><DirectoryHeader menu={arrangements.writable ? [{ label: 'Organize Drive', icon: 'arrow.up.arrow.down', onPress: () => setOrganize(true) }] : undefined} search={{ placeholder: 'Search pages and folders', value: search, onChange: setSearch }} action={canEdit ? { label: 'New', onPress: () => {}, items: create.items } : undefined} /><Screen keyboard nativeScroll padded={false} edges={['left', 'right']}><Stack style={{ flex: 1 }}>
    {create.error && <ErrorState message={create.error} />}
    {search.trim() ? <ScreenList contentContainerStyle={listContentStyle} data={found ?? []} keyboardShouldPersistTaps="handled" keyExtractor={(page) => page._id}
      renderItem={({ item }) => <ListRow title={item.title || 'Untitled'} description={item.path.join(' / ') || 'Top level'} leading={item.kind === 'folder' ? <FolderIcon size={theme.sizes.icon} color={theme.colors.muted} /> : <PageIcon size={theme.sizes.icon} color={theme.colors.muted} />} onPress={() => openPage(item._id)} />}
      ListEmptyComponent={found === undefined ? <Loading /> : <EmptyState title="Nothing found" description="Try a different title." />} />
      : <DriveList uploads={uploads.uploads} onDismissUpload={uploads.dismiss} onSelectPage={openPage} empty={{ title: 'Nothing in Drive yet', description: canEdit ? 'Press + to write a page, make a folder or upload files.' : 'Pages, folders and files put here will show up.' }} />}
    {organize && <PageOrganizer onClose={() => setOrganize(false)} />}
    {create.sheet}
  </Stack></Screen></>;
}

/** A page's sub-pages (pages only: files live in folders and at the top). */
export function PageChildren({ parentId, onSelect = openPage }: { parentId?: Id<'pages'>; onSelect?: (id: Id<'pages'>) => void }) {
  return <DriveList parentId={parentId} withFiles={false} onSelectPage={onSelect} empty={{ title: 'No sub-pages', description: 'Create a page inside this one to organize your work.' }} />;
}

export function NewPage({ parentId, kind = 'page', onClose }: { parentId?: Id<'pages'>; kind?: 'page' | 'folder'; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [created, setCreated] = useState<Id<'pages'>>();
  const create = useMutation(api.pages.create);
  const task = useTask();
  const busy = task.busy || !!created;
  const guard = useDraftGuard({ dirty: !!title, busy, onClose });
  const save = () => { if (!busy) void task.run(async () => { const id = await create({ title: title.trim() || (kind === 'folder' ? 'New folder' : 'Untitled'), parentId, ...(kind === 'folder' ? { kind } : {}) }); guard.complete(); setCreated(id); }); };
  const heading = kind === 'folder' ? 'New folder' : parentId ? 'New sub-page' : 'New page';
  return <EditorSheet size="content" title={heading} open={!created} onDismiss={() => { if (created) { onClose(); openPage(created); } }} busy={busy} dismissible={guard.dismissible} onClose={() => void guard.close()} submit={{ label: 'Create', disabled: busy, onPress: save }}>
    {guard.dialog}
    <Field label={kind === 'folder' ? 'Name' : 'Title'} value={title} onChangeText={setTitle} editable={!busy} autoFocus placeholder={kind === 'folder' ? 'New folder' : 'Untitled'} />
    {task.error && <ErrorState message={task.error} />}
  </EditorSheet>;
}

/** Reorders a level's folders, pages and files together: they share one saved order with desktop. */
export function PageOrganizer({ parentId, withFiles = true, onClose }: { parentId?: Id<'pages'>; withFiles?: boolean; onClose: () => void }) {
  const level = useDriveLevel(parentId, withFiles);
  return <ReorderSheet title={parentId ? 'Organize this folder' : 'Organize Drive'} list="pages" entityId={parentId}
    items={level.rows.map(row => ({ _id: row._id, title: row.row === 'file' ? row.name : row.title || 'Untitled' }))} loading={level.loading}
    complete={level.complete} loadingMore={level.loadingMore} onLoadMore={level.loadMore} onClose={onClose} />;
}
