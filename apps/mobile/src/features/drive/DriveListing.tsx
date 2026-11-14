import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { fileKind, formatFileSize } from '@companybot/core/files';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { Button, EmptyState, ListRow, Loading, ScreenList, listContentStyle } from '@/components/ui';
import { FolderIcon, PageIcon } from '@/design/icons';
import { useTheme } from '@/design';
import { useArrangements } from '@/features/arrangements/useArrangements';
import { api } from '@/lib/api';
import { usePaginatedQuery, useQuery } from '@/lib/convex';
import { FileKindIcon } from './FileKindIcon';
import type { DriveUpload } from './uploads';

export const openFile = (fileId: string) => router.push({ pathname: '/files/[fileId]', params: { fileId } });

/** "Folders on top" (Your preferences): folders ahead of the rest, each keeping its order. Desktop's rule. */
export function foldersFirst<T>(rows: readonly T[], isFolder: (row: T) => boolean): T[] {
  const folders = rows.filter(isFolder);
  return folders.length && folders.length < rows.length ? [...folders, ...rows.filter(row => !isFolder(row))] : [...rows];
}

type PageRow = { _id: Id<'pages'>; title: string; kind: 'page' | 'folder'; hasChildren?: boolean; canEdit?: boolean };
type FileRow = { _id: Id<'driveFiles'>; name: string; type: string; size: number; canEdit?: boolean };
export type DriveRow = ({ row: 'page' } & PageRow) | ({ row: 'file' } & FileRow);

/**
 * One Drive level: its folders, pages and (in a folder or at the top) files, in the order people put
 * them, which desktop's sidebar shares (the "pages" arrangement holds file ids too).
 */
export function useDriveLevel(parentId: Id<'pages'> | undefined, withFiles: boolean) {
  const pages = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
  const files = usePaginatedQuery(api.driveFiles.children, withFiles ? { parentId } : 'skip', { initialNumItems: 30 });
  const arrangements = useArrangements();
  const onTop = useQuery(api.preferences.get)?.foldersFirst ?? false;
  const rows = useMemo(() => {
    const all: DriveRow[] = [...pages.results.map(p => ({ ...p, row: 'page' as const })), ...(withFiles ? files.results.map(f => ({ ...f, row: 'file' as const })) : [])];
    const ordered = arrangements.order('pages', all, parentId);
    return onTop ? foldersFirst(ordered, r => r.row === 'page' && r.kind === 'folder') : ordered;
  }, [arrangements, files.results, onTop, pages.results, parentId, withFiles]);
  const more = pages.status === 'CanLoadMore' || (withFiles && files.status === 'CanLoadMore');
  const loadingMore = pages.status === 'LoadingMore' || (withFiles && files.status === 'LoadingMore');
  return {
    rows,
    loading: pages.status === 'LoadingFirstPage' || (withFiles && files.status === 'LoadingFirstPage') || !arrangements.loaded,
    complete: pages.status === 'Exhausted' && (!withFiles || files.status === 'Exhausted'),
    more, loadingMore,
    loadMore: () => { if (pages.status === 'CanLoadMore') pages.loadMore(30); if (withFiles && files.status === 'CanLoadMore') files.loadMore(30); },
  };
}

export function DriveRowItem({ item, onSelectPage, disclosure }: { item: DriveRow; onSelectPage: (id: Id<'pages'>) => void; disclosure?: boolean }) {
  const { colors, sizes } = useTheme();
  if (item.row === 'file') return <ListRow title={item.name} description={`${fileKind(item.type)} · ${formatFileSize(item.size)}`} leading={<FileKindIcon type={item.type} name={item.name} size={sizes.icon} color={colors.muted} />} disclosure={disclosure} onPress={() => openFile(item._id)} />;
  return <ListRow title={item.title || 'Untitled'} description={item.kind === 'folder' ? 'Folder' : item.hasChildren ? 'Contains sub-pages' : undefined} leading={item.kind === 'folder' ? <FolderIcon size={sizes.icon} color={colors.muted} /> : <PageIcon size={sizes.icon} color={colors.muted} />} disclosure={disclosure} onPress={() => onSelectPage(item._id)} />;
}

export function UploadRow({ upload, onDismiss }: { upload: DriveUpload; onDismiss: () => void }) {
  const { colors, sizes } = useTheme();
  return <ListRow title={upload.name} description={upload.error ? `${upload.error} Tap to dismiss.` : upload.state === 'waiting' ? 'Waiting to upload…' : 'Uploading…'} leading={<FileKindIcon name={upload.name} size={sizes.icon} color={upload.error ? colors.danger : colors.muted} />} onPress={upload.error ? onDismiss : undefined} accessibilityLabel={`${upload.name}, ${upload.error ? `upload failed: ${upload.error}` : 'uploading'}`} />;
}

/** A Drive level as a screen's list, with this folder's uploads in flight beneath it. */
export function DriveList({ parentId, withFiles = true, uploads = [], onDismissUpload, onSelectPage, empty }: {
  parentId?: Id<'pages'>; withFiles?: boolean; uploads?: DriveUpload[]; onDismissUpload?: (key: string) => void;
  onSelectPage: (id: Id<'pages'>) => void; empty: { title: string; description: string };
}) {
  const level = useDriveLevel(parentId, withFiles);
  return <ScreenList contentContainerStyle={listContentStyle} data={level.rows} keyboardShouldPersistTaps="handled" keyExtractor={row => row._id}
    renderItem={({ item }) => <DriveRowItem item={item} onSelectPage={onSelectPage} disclosure={item.row === 'page'} />}
    ListEmptyComponent={level.loading ? <Loading /> : uploads.length ? undefined : <EmptyState title={empty.title} description={empty.description} />}
    ListFooterComponent={<>
      {uploads.map(u => <UploadRow key={u.key} upload={u} onDismiss={() => onDismissUpload?.(u.key)} />)}
      {level.more || level.loadingMore ? <Button label="Load more" variant="ghost" loading={level.loadingMore} onPress={level.loadMore} /> : null}
    </>} />;
}

/** System file picker; returns nothing when cancelled. */
export async function pickFiles() {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  return result.canceled ? [] : result.assets;
}
