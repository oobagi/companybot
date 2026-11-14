import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { formatFileSize } from '@companybot/core/files';
import { router, Stack as RouterStack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import { Badge, EditorSheet, EmptyState, ErrorState, Field, Loading, Screen, Stack, Text } from '@/components/ui';
import type { Action } from '@/components/ui/ActionMenu';
import { useTheme } from '@/design';
import { AccessSheet } from '@/features/access/AccessSheet';
import { useDocumentConfirm } from '@/features/documents/Confirm';
import { openPage } from '@/features/documents/PagesScreen';
import { usePinAction } from '@/features/pins/usePins';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { useTask } from '@/lib/useTask';
import { FileViewer } from './FileViewer';
import { MoveToFolder } from './MoveToFolder';

// A file in Drive, at /files/<id>: shown inline where we can, with rename, move, access and Archive
// like a page. Desktop's FileScreen, natively.

export function FileScreen({ fileId }: { fileId: string }) {
  const file = useQuery(api.driveFiles.get, { fileId });
  const pin = usePinAction(file ? `file:${file._id}` : undefined);
  const [panel, setPanel] = useState<'rename' | 'move' | 'access'>();
  const archive = useMutation(api.trash.move);
  const restore = useMutation(api.trash.restore);
  const setAccess = useMutation(api.driveFiles.setAccess);
  const task = useTask();
  const { confirm, dialog } = useDocumentConfirm();
  const theme = useTheme();
  if (file === undefined) return <Screen><Loading /></Screen>;
  if (!file) return <Screen><EmptyState title="File not found" description="It may have been removed or you no longer have access." /></Screen>;
  const editable = file.canEdit && !file.archived;
  const actions: Action[] = [
    { id: 'pin', title: pin.label, disabled: pin.disabled, icon: 'pin' },
    ...(file.url ? [{ id: 'open', title: 'Open in browser', icon: 'safari' as const }] : []),
    ...(file.ancestors.length ? [{ id: 'ancestors', title: 'Folders', icon: 'folder' as const, items: file.ancestors.map(a => ({ id: `parent:${a._id}`, title: a.title || 'Untitled' })) }] : []),
    { id: 'access', title: 'Who can access', icon: 'lock' },
    ...(editable ? [
      { id: 'rename', title: 'Rename', icon: 'pencil' as const },
      { id: 'move', title: 'Move to…', icon: 'folder' as const },
      { id: 'archive', title: 'Archive file', icon: 'archivebox' as const, destructive: true },
    ] : []),
    ...(file.trash?.canRestore ? [{ id: 'restore', title: 'Restore file', icon: 'arrow.uturn.backward' as const }] : []),
  ];
  const open = () => { if (file.url) void task.run(() => WebBrowser.openBrowserAsync(file.url!)); };
  const back = () => { if (router.canGoBack()) router.back(); else if (file.parentId) openPage(file.parentId); else router.replace('/pages'); };
  const perform = (action: string) => {
    if (action === 'pin') pin.onPress();
    else if (action === 'open') open();
    else if (action.startsWith('parent:')) openPage(action.slice(7));
    else if (action === 'restore' && file.trash?.canRestore) void task.run(() => restore({ kind: file.trash!.kind, id: file.trash!.itemId }));
    else if (action === 'archive') void task.run(async () => {
      if (!await confirm({ title: `Archive ${file.name}?`, body: 'You can restore it from Archive.', action: 'Archive', danger: true })) return;
      await archive({ kind: 'file', id: file._id });
      back();
    });
    else if (action === 'rename' || action === 'move' || action === 'access') setPanel(action);
  };
  return <Screen padded={false}>
    <RouterStack.Screen options={{ title: file.name }} />
    <HeaderMenu label="File actions" actions={actions.map(action => ({ ...action, disabled: action.disabled || task.busy }))} onAction={perform} />
    {dialog}
    <ScrollView contentContainerStyle={{ padding: theme.sizes.gutter, gap: theme.spacing.md }}>
      <Text tone="muted">{file.kind} · {formatFileSize(file.size)}{file.ancestors.length ? ` · ${file.ancestors.map(a => a.title || 'Untitled').join(' / ')}` : ''}</Text>
      {(pin.error || task.error) && <Stack gap="sm">{pin.error && <ErrorState message={pin.error} />}{task.error && <ErrorState message={task.error} />}</Stack>}
      {file.archived && <View style={{ alignSelf: 'flex-start' }}><Badge label={file.trash ? 'Archived · read only' : 'In Archive with a folder you can’t see'} tone="warning" /></View>}
      {file.url ? <FileViewer url={file.url} type={file.type} name={file.name} width={file.width} height={file.height} onOpen={open} /> : <ErrorState message="The file’s content is missing." />}
    </ScrollView>
    {panel === 'rename' && <RenameFile fileId={file._id} name={file.name} editable={editable} onClose={() => setPanel(undefined)} />}
    {panel === 'move' && <MoveFile fileId={file._id} parentId={file.parentId} editable={editable} onClose={() => setPanel(undefined)} />}
    {panel === 'access' && <AccessSheet access={file.access} following={file.parentId ? file.ownAccess === null : undefined} onSave={file.canManageAccess && !file.archived ? entries => setAccess({ fileId: file._id, access: entries }) : undefined} onClose={() => setPanel(undefined)} />}
  </Screen>;
}

function RenameFile({ fileId, name, editable, onClose }: { fileId: Id<'driveFiles'>; name: string; editable: boolean; onClose: () => void }) {
  const [value, setValue] = useState(name);
  const rename = useMutation(api.driveFiles.rename);
  const task = useTask();
  const clean = value.replace(/\s+/g, ' ').trim();
  const disabled = !editable || task.busy || !clean || clean === name;
  const guard = useDraftGuard({ dirty: value !== name, busy: task.busy, onClose, description: 'Your unsaved file name will be discarded.' });
  const save = () => { if (!disabled) void task.run(async () => { await rename({ fileId, name: clean }); guard.complete(); onClose(); }); };
  return <EditorSheet title="Rename file" size="content" busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()} submit={{ label: 'Done', disabled, onPress: save }}>
    {guard.dialog}
    <Field label="Name" value={value} onChangeText={setValue} editable={editable && !task.busy} autoFocus selectTextOnFocus />
    {task.error && <ErrorState message={task.error} />}
  </EditorSheet>;
}

function MoveFile({ fileId, parentId, editable, onClose }: { fileId: Id<'driveFiles'>; parentId: Id<'pages'> | null; editable: boolean; onClose: () => void }) {
  const move = useMutation(api.driveFiles.move);
  return <MoveToFolder title="Move file" noun="file" itemId={fileId} parentId={parentId} editable={editable} onMove={target => move({ fileId, parentId: target })} onClose={onClose} />;
}
