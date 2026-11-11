import { usePinAction } from '@/features/pins/usePins';
import { HeaderMenu } from '@/components/navigation/HeaderMenu';
import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { router, Stack as RouterStack } from 'expo-router';
import { useLayoutEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
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
    ...(page.kind !== 'folder' ? [{ id: 'history', title: 'History', icon: 'clock.arrow.circlepath' as const }] : []),
    ...(page.recordId ? [{ id: 'record', title: 'Open record', icon: 'doc.text' as const }] : []),
    { id: 'access', title: 'Who can access', icon: 'lock' },
    ...(!page.recordId && page.kind !== 'folder' ? [{ id: 'children', title: 'Sub-pages', icon: 'folder' as const }] : []),
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
  return <Screen keyboard={page.kind !== 'folder'} nativeScroll={page.kind === 'folder'} padded={false}>
    <RouterStack.Screen options={{ title: page.recordId ? 'Notes' : page.title || 'Untitled' }} />
    <HeaderMenu label="Page actions" actions={actions.map(action => ({ ...action, disabled: action.disabled || task.busy }))} onAction={perform} />
    {dialog}
    {(pin.error || page.archived || task.error) && <View style={{ paddingHorizontal: theme.sizes.gutter, paddingVertical: theme.spacing.sm, gap: theme.spacing.sm }}>
      {pin.error && <ErrorState message={pin.error} />}
      {page.archived && <Badge label="Archived · read only" tone="warning" />}
      {task.error && <ErrorState message={task.error} />}
    </View>}
    {page.kind === 'folder' ? <PageChildren parentId={page._id} /> : <DocumentEditor pageId={page._id} editable={page.canEdit} />}
    {panel === 'organize' && <PageOrganizer parentId={page._id} onClose={() => setPanel(undefined)} />}
    {panel === 'access' && <AccessSheet access={page.access} following={page.parentId && !page.recordId ? page.ownAccess === null : undefined} description={page.recordId ? 'This page follows its database. Change access in the database’s menu.' : undefined} onSave={page.canManageAccess && !page.archived ? entries => setAccess({ pageId: page._id, access: entries }) : undefined} onClose={() => setPanel(undefined)} />}
    {panel === 'rename' && <RenamePage pageId={page._id} title={page.title} editable={page.canEdit && !page.archived && !page.recordId} onClose={() => setPanel(undefined)} />}
    {panel === 'move' && <MovePage pageId={page._id} parentId={page.parentId} kind={page.kind} editable={page.canEdit && !page.archived && !page.recordId} onClose={() => setPanel(undefined)} />}
    {panel === 'create' && <NewPage parentId={page._id} onClose={() => setPanel(undefined)} />}
    {panel === 'history' && <PageHistory pageId={page._id} canRestore={page.canEdit && !page.archived} onClose={() => setPanel(undefined)} />}
    {panel === 'children' && <EditorSheet title="Sub-pages" scroll={false} onClose={() => setPanel(undefined)}>
      <PageChildren parentId={page._id} onSelect={(id) => { setPanel(undefined); openPage(id); }} />
      {page.canEdit && !page.archived && <ContentToolbar accessibilityLabel="Sub-page actions" actions={[{ id: 'create', label: 'New sub-page', icon: { ios: 'plus', android: Add }, onPress: () => setPanel('create') }]} />}
    </EditorSheet>}
  </Screen>;
}

function RenamePage({ pageId, title, editable, onClose }: { pageId: Id<'pages'>; title: string; editable: boolean; onClose: () => void }) {
  const [value, setValue] = useState(title);
  const [baseline, setBaseline] = useState(title);
  const rename = useMutation(api.pages.rename);
  const task = useTask();
  const conflict = title !== baseline;
  const clean = value.replace(/\s+/g, ' ').trim();
  const disabled = !editable || task.busy || conflict || !clean || clean === baseline;
  const guard = useDraftGuard({ dirty: value !== baseline, busy: task.busy, onClose, description: 'Your unsaved page title will be discarded.' });
  const save = () => {
    if (disabled) return;
    void task.run(async () => { await rename({ pageId, title: clean }); guard.complete(); onClose(); });
  };
  return <EditorSheet title="Rename page" size="content" busy={task.busy} dismissible={guard.dismissible} onClose={() => void guard.close()} submit={{ label: 'Done', disabled, onPress: save }}>
    {guard.dialog}
    {!editable && <Text tone="muted">This page is read only. Your unsaved title is kept here until you cancel.</Text>}
    {conflict && <>
      <Text>The page title changed while you were editing. Reload it before saving.</Text>
      <Button label="Reload latest" variant="secondary" disabled={task.busy} onPress={() => { setValue(title); setBaseline(title); task.clear(); }} />
    </>}
    <Field label="Title" value={value} onChangeText={setValue} editable={editable && !task.busy} autoFocus />
    {task.error && <ErrorState message={task.error} />}
  </EditorSheet>;
}

function MovePage({ pageId, parentId, kind, editable, onClose }: { pageId: Id<'pages'>; parentId: Id<'pages'> | null; kind: 'page' | 'folder'; editable: boolean; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const searching = !!search.trim();
  const matches = useQuery(api.pages.search, searching ? { query: search.trim() } : 'skip');
  const roots = usePaginatedQuery(api.pages.children, {}, { initialNumItems: 30 });
  const arrangements = useArrangements();
  const move = useMutation(api.pages.move);
  const task = useTask();
  const loading = searching ? matches === undefined : roots.status === 'LoadingFirstPage';
  const destinations = (searching ? matches ?? [] : arrangements.order('pages', roots.results))
    .filter(row => row._id !== pageId && row.kind === 'folder');
  const choose = (target?: Id<'pages'>) => {
    if (!editable || task.busy || target === (parentId ?? undefined)) return;
    if (target && !destinations.some(row => row._id === target && row.canEdit)) return;
    void task.run(async () => { await move({ pageId, parentId: target }); onClose(); });
  };
  return <EditorSheet title={kind === 'folder' ? 'Move folder' : 'Move page'} scroll={false} busy={task.busy} onClose={onClose}>
    <Text tone="muted">Choose a folder. Everything inside moves with this {kind}.</Text>
    {!editable && <Text tone="muted">This page is read only and cannot be moved.</Text>}
    <Field label="Find destination" value={search} onChangeText={setSearch} editable={editable && !task.busy} autoCorrect={false} />
    {task.error && <ErrorState message={task.error} />}
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ flexGrow: 1 }}>
      <ListRow title="Top level" selected={!parentId} disabled={!editable || task.busy || !parentId} onPress={() => choose()} />
      {loading ? <Loading label="Loading destinations…" /> : destinations.map(row => <ListRow key={row._id} title={row.title || 'Untitled'} description={'path' in row ? row.path.join(' / ') : undefined} selected={row._id === parentId} disabled={!editable || task.busy || row._id === parentId || !row.canEdit} onPress={() => choose(row._id)} />)}
      {!loading && !destinations.length && <EmptyState title={searching ? 'No matching destinations' : 'No destinations yet'} description="Try searching for a folder, or move to the top level." />}
      {!searching && (roots.status === 'CanLoadMore' || roots.status === 'LoadingMore') && <Button label="More destinations" variant="ghost" disabled={!editable || task.busy} loading={roots.status === 'LoadingMore'} onPress={() => roots.loadMore(30)} />}
    </ScrollView>
  </EditorSheet>;
}

function PageHistory({ pageId, canRestore, onClose }: { pageId: Id<'pages'>; canRestore: boolean; onClose: () => void }) {
  const theme = useTheme();
  const [tab, setTab] = useState<'content' | 'moves'>('content');
  const [selected, setSelected] = useState<Id<'pageVersions'>>();
  const history = usePaginatedQuery(api.pages.history, { pageId }, { initialNumItems: 20 });
  const content = useQuery(api.pages.version, selected ? { versionId: selected } : 'skip');
  const restore = useMutation(api.pages.restore);
  const task = useTask();
  const { confirm, dialog } = useDocumentConfirm();
  const restorable = canRestore && !!selected && content != null && history.status !== 'LoadingFirstPage' && selected !== history.results[0]?._id;
  const latest = useRef({ restorable, selected });
  useLayoutEffect(() => {
    latest.current = { restorable, selected };
    return () => { latest.current = { restorable: false, selected: undefined }; };
  }, [restorable, selected]);
  return <EditorSheet title={selected ? 'Version preview' : 'Page history'} scroll={false} busy={task.busy} onClose={onClose}>
    {dialog}
    {task.error && <ErrorState message={task.error} />}
    {selected ? <>
      <Button label="Back to versions" variant="ghost" disabled={task.busy} onPress={() => setSelected(undefined)} />
      <View style={{ flex: 1, minHeight: 0, marginHorizontal: -theme.spacing.lg }}><HistoryPreview versionId={selected} content={content} /></View>
      {restorable && <Button label="Restore this version" loading={task.busy} onPress={() => void task.run(async () => {
        if (!await confirm({ title: 'Restore this version?', body: 'This becomes the current content. Your current version stays in history.', action: 'Restore version' })) return;
        if (!latest.current.restorable || latest.current.selected !== selected) return;
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

function HistoryPreview({ versionId, content }: { versionId: Id<'pageVersions'>; content: string | null | undefined }) {
  return content === undefined ? <Loading /> : content === null ? <EmptyState title="Version unavailable" description="This version may have expired from history." /> : <VersionDocument content={content} identity={versionId} />;
}
function PageMoves({ pageId }: { pageId: Id<'pages'> }) {
  const moves = usePaginatedQuery(api.pages.moves, { pageId }, { initialNumItems: 20 });
  return <ScrollView contentContainerStyle={{ flexGrow: 1 }}>{moves.results.map((move) => <ListRow key={move._id} title={`Moved from ${move.from} to ${move.to}`} description={`${move.agent ?? move.user} · ${new Date(move._creationTime).toLocaleString()}`} />)}
    {moves.status === 'LoadingFirstPage' && <Loading />}{moves.status === 'Exhausted' && !moves.results.length && <EmptyState title="No moves yet" />}
    {(moves.status === 'CanLoadMore' || moves.status === 'LoadingMore') && <Button label="Older moves" variant="ghost" loading={moves.status === 'LoadingMore'} onPress={() => moves.loadMore(20)} />}
  </ScrollView>;
}
