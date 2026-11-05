import { usePinAction } from '@/features/pins/usePins';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { router, Stack as RouterStack } from 'expo-router';
import { useState } from 'react';
import { ScrollView } from 'react-native';
import Add from '@expo/material-symbols/add.xml';
import { Badge, Button, ChoicePicker, EditorSheet, EmptyState, ErrorState, Field, ListRow, Loading, Screen, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { api } from '@/lib/api';
import { useMutation, usePaginatedQuery, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { DocumentEditor, VersionDocument } from './DocumentEditor';
import { NewPage, openPage, PageChildren, PageOrganizer } from './PagesScreen';
import { useDocumentConfirm } from './Confirm';
import { AccessSheet } from '@/features/access/AccessSheet';
import { useArrangements } from '@/features/arrangements/useArrangements';
import type { Action } from '@/components/ui/ActionMenu';
import { ContentToolbar } from '@/components/ui/ContentToolbar';

export function PageScreen({ pageId }: { pageId: string }) {
  const page = useQuery(api.pages.get, { pageId });
  const arrangements = useArrangements();
  const pin = usePinAction(page ? page.recordId ? `rec:${page.recordId}` : `page:${page._id}` : undefined);
  const [panel, setPanel] = useState<'rename' | 'move' | 'history' | 'children' | 'create' | 'access' | 'organize'>();
  const archive = useMutation(api.trash.move);
  const restore = useMutation(api.trash.restore);
  const setAccess = useMutation(api.pages.setAccess);
  const task = useTask();
  const { confirm, dialog } = useDocumentConfirm();
  const theme = useTheme();
  if (page === undefined) return <Screen><Loading /></Screen>;
  if (!page) return <Screen><EmptyState title="Page not found" description="It may have been removed or you no longer have access." /></Screen>;
  const actions: Action[] = [
    { id: 'pin', title: pin.label, disabled: pin.disabled, icon: 'pin' },
    { id: 'history', title: 'History', icon: 'clock.arrow.circlepath' },
    ...(page.recordId ? [{ id: 'record', title: 'Open record', icon: 'doc.text' as const }] : []),
    { id: 'access', title: 'Who can access', icon: 'lock' },
    ...(!page.recordId ? [{ id: 'children', title: 'Sub-pages', icon: 'folder' as const }] : []),
    ...(page.ancestors.length ? [{ id: 'ancestors', title: 'Parent pages', icon: 'folder' as const, items: page.ancestors.map(ancestor => ({ id: `parent:${ancestor._id}`, title: ancestor.title || 'Untitled' })) }] : []),
    ...(page.canEdit && !page.archived && !page.recordId ? [
      { id: 'rename', title: 'Rename', icon: 'pencil' as const },
      { id: 'move', title: 'Move to…', icon: 'folder' as const },
      { id: 'create', title: 'New sub-page', icon: 'plus' as const },
      { id: 'archive', title: 'Archive page', icon: 'archivebox' as const, destructive: true },
    ] : []),
    ...(arrangements.writable && !page.recordId && !page.archived ? [{ id: 'organize', title: 'Organize sub-pages', icon: 'arrow.up.arrow.down' as const }] : []),
    ...(page.trash?.canRestore ? [{ id: 'restore', title: 'Restore page', icon: 'arrow.uturn.backward' as const }] : []),
  ];
  const perform = (action: string) => {
    if (action === 'pin') pin.onPress();
    else if (action === 'record' && page.recordId) router.push(`/record/${page.recordId}`);
    else if (action.startsWith('parent:')) openPage(action.slice(7));
    else if (action === 'restore' && page.trash?.canRestore) void task.run(() => restore({ kind: page.trash!.kind, id: page.trash!.itemId }));
    else if (action === 'archive') void task.run(async () => {
      if (!await confirm({ title: `Archive ${page.title || 'Untitled'}?`, body: 'Its sub-pages will be archived with it. You can restore them from Archive.', action: 'Archive', danger: true })) return;
      await archive({ kind: 'page', id: page._id });
      router.replace(page.parentId ? { pathname: '/pages/[pageId]', params: { pageId: page.parentId } } : '/pages');
    });
    else if (action === 'history' || action === 'access' || action === 'children' || action === 'rename' || action === 'move' || action === 'create' || action === 'organize') setPanel(action);
  };
  return <Screen keyboard contentStyle={{ gap: theme.spacing.sm }}>
    <RouterStack.Screen options={{ title: page.recordId ? 'Notes' : page.title || 'Untitled' }} />
    <HeaderMenu label="Page actions" actions={actions.map(action => ({ ...action, disabled: action.disabled || task.busy }))} onAction={perform} />
    {pin.error && <ErrorState message={pin.error} />}
    {dialog}
    {page.archived && <Badge label="Archived · read only" tone="warning" />}
    {task.error && <ErrorState message={task.error} />}
    <DocumentEditor pageId={page._id} editable={page.canEdit} />
    {panel === 'organize' && <PageOrganizer parentId={page._id} onClose={() => setPanel(undefined)} />}
    {panel === 'access' && <AccessSheet access={page.access} following={page.parentId && !page.recordId ? page.ownAccess === null : undefined} description={page.recordId ? 'This page follows its database. Change access in the database’s menu.' : undefined} onSave={page.canManageAccess && !page.archived ? entries => setAccess({ pageId: page._id, access: entries }) : undefined} onClose={() => setPanel(undefined)} />}
    {panel === 'rename' && <RenamePage pageId={page._id} title={page.title} onClose={() => setPanel(undefined)} />}
    {panel === 'move' && <MovePage pageId={page._id} parentId={page.parentId} onClose={() => setPanel(undefined)} />}
    {panel === 'create' && <NewPage parentId={page._id} onClose={() => setPanel(undefined)} />}
    {panel === 'history' && <PageHistory pageId={page._id} canRestore={page.canEdit} onClose={() => setPanel(undefined)} />}
    {panel === 'children' && <EditorSheet title="Sub-pages" scroll={false} onClose={() => setPanel(undefined)}>
      <PageChildren parentId={page._id} onSelect={(id) => { setPanel(undefined); openPage(id); }} />
      {page.canEdit && !page.archived && <ContentToolbar accessibilityLabel="Sub-page actions" actions={[{ id: 'create', label: 'New sub-page', icon: { ios: 'plus', android: Add }, onPress: () => setPanel('create') }]} />}
    </EditorSheet>}
  </Screen>;
}

function RenamePage({ pageId, title, onClose }: { pageId: Id<'pages'>; title: string; onClose: () => void }) {
  const [value, setValue] = useState(title);
  const [baseline] = useState(title);
  const rename = useMutation(api.pages.rename);
  const task = useTask();
  const guard = useDraftGuard({ dirty: value !== baseline, busy: task.busy, onClose, description: 'Your unsaved page title will be discarded.' });
  return <EditorSheet title="Rename page" busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()}>{guard.dialog}<Field label="Title" value={value} onChangeText={setValue} editable={!task.busy} autoFocus />
    {task.error && <ErrorState message={task.error} />}
    <Button label="Save title" loading={task.busy} disabled={!value.trim()} onPress={() => void task.run(async () => { await rename({ pageId, title: value.trim() }); onClose(); })} />
  </EditorSheet>;
}

function MovePage({ pageId, parentId, onClose }: { pageId: Id<'pages'>; parentId: Id<'pages'> | null; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const matches = useQuery(api.pages.search, search.trim() ? { query: search.trim() } : 'skip');
  const roots = usePaginatedQuery(api.pages.children, {}, { initialNumItems: 30 });
  const arrangements = useArrangements();
  const move = useMutation(api.pages.move);
  const task = useTask();
  const choose = (target?: Id<'pages'>) => void task.run(async () => { await move({ pageId, parentId: target }); onClose(); });
  return <EditorSheet title="Move page" busy={task.busy} onClose={onClose}>
    <Text tone="muted">Choose a destination. Sub-pages move with this page.</Text>
    <Field label="Find destination" value={search} onChangeText={setSearch} autoCorrect={false} />
    {task.error && <ErrorState message={task.error} />}
    <ListRow title="Top level" selected={!parentId} disabled={task.busy || !parentId} onPress={() => choose()} />
    {(search.trim() ? matches ?? [] : arrangements.order('pages', roots.results)).filter((row) => row._id !== pageId).map((row) => <ListRow key={row._id} title={row.title || 'Untitled'} description={'path' in row ? row.path.join(' / ') : undefined} selected={row._id === parentId} disabled={task.busy || row._id === parentId || !row.canEdit} onPress={() => choose(row._id)} />)}
    {!search.trim() && roots.status === 'CanLoadMore' && <Button label="More destinations" variant="ghost" onPress={() => roots.loadMore(30)} />}
    {search.trim() && matches?.length === 0 && <Text tone="muted">No pages found.</Text>}
  </EditorSheet>;
}

function PageHistory({ pageId, canRestore, onClose }: { pageId: Id<'pages'>; canRestore: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'content' | 'moves'>('content');
  const [selected, setSelected] = useState<Id<'pageVersions'>>();
  const history = usePaginatedQuery(api.pages.history, { pageId }, { initialNumItems: 20 });
  const restore = useMutation(api.pages.restore);
  const task = useTask();
  const { confirm, dialog } = useDocumentConfirm();
  return <EditorSheet title={selected ? 'Version preview' : 'Page history'} scroll={false} busy={task.busy} onClose={onClose}>
    {dialog}
    {task.error && <ErrorState message={task.error} />}
    {selected ? <>
      <Button label="Back to versions" variant="ghost" disabled={task.busy} onPress={() => setSelected(undefined)} />
      <HistoryPreview versionId={selected} />
      {canRestore && selected !== history.results[0]?._id && <Button label="Restore this version" loading={task.busy} onPress={() => void task.run(async () => {
        if (!await confirm({ title: 'Restore this version?', body: 'This becomes the current content. Your current version stays in history.', action: 'Restore version' })) return;
        await restore({ versionId: selected }); onClose();
      })} />}
    </> : <>
      <ChoicePicker label="History" presentation="compact" value={tab} options={[{ value: 'content', label: 'Content' }, { value: 'moves', label: 'Moves' }]} onChange={value => { if (value === 'content' || value === 'moves') setTab(value); }} />
      {tab === 'moves' ? <PageMoves pageId={pageId} /> : <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        {history.status === 'LoadingFirstPage' && <Loading />}
        {history.status === 'Exhausted' && !history.results.length && <EmptyState title="No edits yet" />}
        {history.results.map((version, index) => <ListRow key={version._id} title={new Date(version.time).toLocaleString()} description={`${index === 0 ? 'Current · ' : ''}${version.restored ? 'Restored' : 'Edited'} by ${[version, ...version.others].map((who) => who.agent ? `${who.agent}, for ${who.user}` : who.user).join(', ')}`} onPress={() => setSelected(version._id)} />)}
        {(history.status === 'CanLoadMore' || history.status === 'LoadingMore') && <Button label="Older versions" variant="ghost" loading={history.status === 'LoadingMore'} onPress={() => history.loadMore(20)} />}
      </ScrollView>}
    </>}
  </EditorSheet>;
}

function HistoryPreview({ versionId }: { versionId: Id<'pageVersions'> }) {
  const content = useQuery(api.pages.version, { versionId });
  return content === undefined ? <Loading /> : content === null ? <EmptyState title="Version unavailable" description="This version may have expired from history." /> : <VersionDocument content={content} identity={versionId} />;
}
function PageMoves({ pageId }: { pageId: Id<'pages'> }) {
  const moves = usePaginatedQuery(api.pages.moves, { pageId }, { initialNumItems: 20 });
  return <ScrollView contentContainerStyle={{ flexGrow: 1 }}>{moves.results.map((move) => <ListRow key={move._id} title={`Moved from ${move.from} to ${move.to}`} description={`${move.agent ?? move.user} · ${new Date(move._creationTime).toLocaleString()}`} />)}
    {moves.status === 'LoadingFirstPage' && <Loading />}{moves.status === 'Exhausted' && !moves.results.length && <EmptyState title="No moves yet" />}
    {(moves.status === 'CanLoadMore' || moves.status === 'LoadingMore') && <Button label="Older moves" variant="ghost" loading={moves.status === 'LoadingMore'} onPress={() => moves.loadMore(20)} />}
  </ScrollView>;
}
