import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { imageError, imageHeadBytes, imageMaxBytes, imageTypes } from '@companybot/core/images';
import { linkedPageId } from '@companybot/core/page-links';
import { useAuthToken } from '@convex-dev/auth/react';
import { useConvex, useConvexConnectionState, useQuery as useRawQuery } from 'convex/react';
import { fetch as expoFetch } from 'expo/fetch';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as Linking from 'expo-linking';
import { router, usePreventRemove } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { ContentToolbar } from '@/components/ui/ContentToolbar';
import PhotoIcon from '@expo/material-symbols/image.xml';
import PageIcon from '@expo/material-symbols/note_add.xml';
import BlocksIcon from '@expo/material-symbols/more_horiz.xml';
import { useTheme } from '@/design';
import { api, errorMessage } from '@/lib/api';
import { useMutation, useQuery, useWorkspace } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import DocumentDOM from './Editor.dom';
import type { Reference } from './schema';
import { useDocumentConfirm } from './Confirm';
import type { Submit } from './transport';
import { boundDocumentSteps } from './requests';
import { useUnsavedDocument } from '@/lib/UnsavedWork';
import { useDocumentActions } from './DocumentActions';
import type { DocumentCommand } from './commands';
import { encodeDocumentPayload } from './domPayload';

export function DocumentEditor({ pageId, editable }: { pageId: Id<'pages'>; editable: boolean }) {
  // pageSync resolves access from the document itself; first validate the selected workspace as well.
  const page = useQuery(api.pages.get, { pageId });
  if (page === undefined) return <Loading label="Loading document…" />;
  if (!page) return <EmptyState title="Document unavailable" description="It may have been removed or belong to another workspace." />;
  return <ConnectedEditor key={pageId} pageId={pageId} editable={editable && page.canEdit && !page.archived} standalone={!page.recordId} />;
}

function ConnectedEditor({ pageId, editable, standalone }: { pageId: Id<'pages'>; editable: boolean; standalone: boolean }) {
  const convex = useConvex();
  const connection = useConvexConnectionState();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') setRetry(n => n + 1); });
    return () => subscription.remove();
  }, []);
  const workspace = useWorkspace();
  const theme = useTheme();
  const snapshot = useRawQuery(api.pageSync.getSnapshot, { id: pageId });
  const version = useRawQuery(api.pageSync.latestVersion, { id: pageId });
  const [dirty, setDirty] = useState(false);
  useUnsavedDocument(pageId, dirty);
  const [error, setError] = useState<string>();
  const [references, setReferences] = useState<Record<string, Reference>>({});
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [image, setImage] = useState<{ url: string; request: number }>();
  const [command, setCommand] = useState<DocumentCommand>();
  const sendCommand = (kind: DocumentCommand['kind']) => setCommand(previous => ({ kind, request: (previous?.request ?? 0) + 1 }));
  const { confirm, dialog } = useDocumentConfirm();
  const upload = useTask();
  const archive = useMutation(api.trash.move);
  const addImage = useMutation(api.pages.addImage);
  const create = useMutation(api.pages.create);
  const actions = useDocumentActions({ editable, canCreate: standalone, create: title => {
    if (!editable || !standalone) return Promise.reject(new Error('This document cannot contain sub-pages.'));
    // The DOM cannot supply a workspace, parent, record id, or insertion flag.
    return create({ title, parentId: pageId });
  } });
  const endpoint = useQuery(api.images.uploadEndpoint);
  const token = useAuthToken();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  usePreventRemove(dirty, ({ repeat }) => {
    void confirm({ title: 'Changes are still saving', body: 'Stay on this page until your changes sync. Leaving now may lose your latest edits.', action: 'Leave without saving', danger: true }).then((leave) => { if (leave) { setDirty(false); repeat(); } });
  });
  const status = useCallback(async (unsaved: boolean, message: string | null) => {
    if (!mounted.current) return;
    setDirty(unsaved);
    if (message) setError(message);
    else if (!unsaved) setError(undefined);
  }, []);
  const setReference = useCallback((id: string, value: Reference) => setReferences((previous) => ({ ...previous, [id]: value })), []);
  const removePages = async (ids: string[]) => {
    if (!editable || !workspace) return false;
    const unique = [...new Set(ids)];
    const rows = await Promise.all(unique.map((id) => convex.query(api.pages.get, { workspaceId: workspace.id, pageId: id })));
    const children = rows.filter((page) => page && !page.archived && page.parentId === pageId);
    const yes = await confirm(children.length ? {
      title: children.length === 1 ? `Archive ${children[0]!.title}?` : `Archive ${children.length} pages?`,
      body: 'Removing a child page block archives the page and its sub-pages. You can restore them from Archive.', action: 'Archive', danger: true,
    } : { title: 'Remove page reference?', body: 'The linked pages and their contents will be kept.', action: 'Remove reference' });
    if (!yes) return false;
    for (const child of children) await archive({ kind: 'page', id: child!._id });
    return true;
  };
  const pickImage = () => upload.run(async () => {
    if (!endpoint || !token || !workspace) throw new Error('Still connecting. Try again in a moment.');
    const picked = await DocumentPicker.getDocumentAsync({ type: [...imageTypes], copyToCacheDirectory: true, multiple: false });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) return;
    if ((asset.size ?? 0) > imageMaxBytes) throw new Error('Pick an image under 2 MB.');
    const file = Platform.OS === 'web' ? asset.file : new File(asset.uri);
    if (!file) throw new Error('The selected image could not be read.');
    const invalid = imageError(new Uint8Array(await file.slice(0, imageHeadBytes).arrayBuffer()), file.size);
    if (invalid) throw new Error(invalid);
    const response = await expoFetch(`${endpoint}?workspaceId=${encodeURIComponent(workspace.id)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: file });
    const result = await response.json() as { storageId?: Id<'_storage'>; error?: string };
    if (!response.ok || !result.storageId) throw new Error(result.error ?? 'The image upload failed. Try again.');
    const url = await addImage({ pageId, file: result.storageId });
    if (mounted.current) setImage({ url, request: Date.now() });
  });
  if (snapshot === undefined || version === undefined) return <Loading label="Opening editor…" />;
  if (!snapshot.content || version === null) return <EmptyState title="Document unavailable" />;
  return <View style={{ flex: 1, minHeight: 0 }}>
    {dialog}
    {actions.dialog}
    {(error || upload.error) && <ErrorState message={error ?? upload.error!} onRetry={error ? () => setRetry(n => n + 1) : undefined} />}
    {referenceIds.map((id) => <PageReference key={id} id={id} onChange={setReference} />)}
    <DocumentDOM payload={encodeDocumentPayload({ pageId, snapshot, latestVersion: version, retrySignal: `${connection.connectionCount}:${retry}`, editable, canCreatePage: standalone, command, dark: theme.dark, colors: theme.colors, image, references })} onBlockActions={actions.onBlockActions} onCreatePage={actions.onCreatePage}
      getSteps={(atVersion) => convex.query(api.pageSync.getSteps, { id: pageId, version: atVersion })}
      submitSteps={(args: Submit) => {
        if (!editable) return Promise.reject(new Error('This document is read only.'));
        return convex.mutation(api.pageSync.submitSteps, boundDocumentSteps(pageId, args));
      }}
      onReferences={async (ids) => { setReferenceIds(ids); }} onStatus={status} onRemovePages={removePages}
      onOpenLink={async (href) => {
        const id = linkedPageId(href);
        if (id) router.push({ pathname: '/pages/[pageId]', params: { pageId: id } });
        else if (/^(https?:|mailto:|tel:)/i.test(href)) await Linking.openURL(href).catch((e: unknown) => setError(errorMessage(e)));
      }}
      dom={{ style: { flex: 1, minHeight: 0 }, scrollEnabled: true, contentInsetAdjustmentBehavior: 'never', automaticallyAdjustContentInsets: false }} />
    {editable && <ContentToolbar accessibilityLabel="Document editing" status={upload.busy ? 'Uploading image…' : dirty ? 'Saving changes…' : undefined} busy={upload.busy || actions.busy} actions={[
      { id: 'blocks', label: 'Block actions', icon: { ios: 'ellipsis', android: BlocksIcon }, onPress: () => sendCommand('blocks') },
      { id: 'image', label: 'Add image', icon: { ios: 'photo', android: PhotoIcon }, onPress: () => void pickImage() },
      ...(standalone ? [{ id: 'page', label: 'New sub-page', icon: { ios: 'doc.badge.plus' as const, android: PageIcon }, onPress: () => sendCommand('page') }] : []),
    ]} />}
  </View>;
}

function PageReference({ id, onChange }: { id: string; onChange: (id: string, value: Reference) => void }) {
  const page = useQuery(api.pages.get, { pageId: id });
  useEffect(() => { if (page !== undefined) onChange(id, page ? { title: page.title, archived: page.archived } : null); }, [id, page, onChange]);
  return null;
}

export function VersionDocument({ content, identity }: { content: string; identity: string }) {
  const theme = useTheme();
  return <View style={{ flex: 1, minHeight: 0 }}><DocumentDOM key={identity} payload={encodeDocumentPayload({ pageId: identity, snapshot: { content, version: 1 }, latestVersion: 1, editable: false, canCreatePage: false, dark: theme.dark, colors: theme.colors, references: {} })} onBlockActions={async () => null} onCreatePage={async () => null}
    getSteps={async () => ({ steps: [], clientIds: [], version: 1 })} submitSteps={async () => { throw new Error('History is read only.'); }}
    onReferences={async () => {}} onStatus={async () => {}} onRemovePages={async () => false}
    onOpenLink={async (href) => { const id = linkedPageId(href); if (id) router.push({ pathname: '/pages/[pageId]', params: { pageId: id } }); else if (/^(https?:|mailto:|tel:)/i.test(href)) await Linking.openURL(href); }}
    dom={{ style: { flex: 1, minHeight: 0 }, scrollEnabled: true, contentInsetAdjustmentBehavior: 'never', automaticallyAdjustContentInsets: false }} /></View>;
}
