import type { Id } from '@companybot/backend/convex/_generated/dataModel';
import { imageMaxBytes, imageMaxMb, imageTypes } from '@companybot/core/images';
import { openContentLink } from '@/features/chat/links';
import { useAuthToken } from '@convex-dev/auth/react';
import { useConvex, useConvexConnectionState, useQuery as useRawQuery } from 'convex/react';
import { fetch as expoFetch } from 'expo/fetch';
import { setStringAsync, StringFormat } from 'expo-clipboard';
import type { RecoverySnapshot } from './editorRecovery';
import { recoveryScope, type StoredRecovery } from './documentRecoveryStore';
import { useDocumentRecovery } from './useDocumentRecovery';
import { convexUrl } from '@/lib/config';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { validateImageFile } from '@/lib/imageFile';
import { usePreventRemove } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Platform, useWindowDimensions, View } from 'react-native';
import { Button, EditorSheet, EmptyState, ErrorState, Loading, Stack, Text } from '@/components/ui';
import { DocumentToolbar } from './DocumentToolbar';
import type { DocumentFormatting } from './formatting';
import { useTheme } from '@/design';
import { api, errorMessage } from '@/lib/api';
import { useMutation, useQuery, useWorkspace } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import { DocumentSurface } from './DocumentSurface';
import { documentFontScale } from './editorStartup';
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
  const me = useQuery(api.workspace.me);
  const workspace = useWorkspace();
  if (page === undefined || !me || !workspace) return <Loading label="Loading document…" />;
  if (!page) return <EmptyState title="Document unavailable" description="It may have been removed or belong to another workspace." />;
  const scope = recoveryScope(convexUrl ?? '', me.userId, workspace.id, pageId);
  return <ConnectedEditor key={scope} scope={scope} pageId={pageId} editable={editable && page.canEdit && !page.archived} standalone={!page.recordId} />;
}

function ConnectedEditor({ scope, pageId, editable, standalone }: { scope: string; pageId: Id<'pages'>; editable: boolean; standalone: boolean }) {
  const convex = useConvex();
  const connection = useConvexConnectionState();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') setRetry(n => n + 1); });
    return () => subscription.remove();
  }, []);
  const workspace = useWorkspace();
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const snapshot = useRawQuery(api.pageSync.getSnapshot, { id: pageId });
  const version = useRawQuery(api.pageSync.latestVersion, { id: pageId });
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const drafts = useDocumentRecovery(scope);
  const latestDraft = drafts.latest;
  const [restoredPreview, setRestoredPreview] = useState<StoredRecovery>();
  const recoveryTask = useTask();
  const [recovery, setRecovery] = useState<RecoverySnapshot>();
  const [reviewing, setReviewing] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [error, setError] = useState<string>();
  const [references, setReferences] = useState<Record<string, Reference>>({});
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [image, setImage] = useState<{ url: string; request: number }>();
  const pendingImage = useRef<number | undefined>(undefined);
  const [command, setCommand] = useState<DocumentCommand>();
  const [formatting, setFormatting] = useState<DocumentFormatting>();
  const sendCommand = (kind: DocumentCommand['kind']) => setCommand(previous => ({ kind, request: (previous?.request ?? 0) + 1 }));
  const { confirm, dialog } = useDocumentConfirm();
  const upload = useTask();
  const imageBusy = upload.busy || !!image;
  const latestImageBusy = useRef(imageBusy);
  useLayoutEffect(() => { latestImageBusy.current = imageBusy; }, [imageBusy]);
  useUnsavedDocument(pageId, dirty || !!recovery || !!drafts.restored.length, imageBusy || recoveryTask.busy);
  const archive = useMutation(api.trash.move);
  const addImage = useMutation(api.pages.addImage);
  const create = useMutation(api.pages.create);
  const actions = useDocumentActions({ editable, available: editorReady, canCreate: standalone, create: title => {
    if (!editable || !standalone) return Promise.reject(new Error('This document cannot contain sub-pages.'));
    // The DOM cannot supply a workspace, parent, record id, or insertion flag.
    return create({ title, parentId: pageId });
  } });
  const endpoint = useQuery(api.images.uploadEndpoint);
  const token = useAuthToken();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  usePreventRemove(!leaving && (dirty || !!recovery || !!drafts.restored.length || imageBusy || recoveryTask.busy), ({ repeat }) => {
    // Uploads can already be committed on the server; they are not discardable drafts.
    if (imageBusy || recoveryTask.busy) return;
    void confirm({ title: recovery || drafts.restored.length ? 'Leave recovery draft?' : 'Changes are still saving', body: recovery || drafts.restored.length ? 'Your local recovery copy will remain on this device. It has not been merged into the shared document.' : 'Stay until your changes sync. Any recovery copy saved on this device will be available when you reopen this document.', action: 'Leave page', danger: true }).then((leave) => { if (leave && !latestImageBusy.current) { setLeaving(true); setDirty(false); repeat(); } });
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
  const pickImage = (source: 'photos' | 'files') => upload.run(async () => {
    if (!endpoint || !token || !workspace) throw new Error('Still connecting. Try again in a moment.');
    const picked = source === 'photos'
      ? await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible })
      : await DocumentPicker.getDocumentAsync({ type: [...imageTypes], copyToCacheDirectory: true, multiple: false });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) return;
    if ((('fileSize' in asset ? asset.fileSize : 'size' in asset ? asset.size : undefined) ?? 0) > imageMaxBytes) throw new Error(`Pick an image under ${imageMaxMb} MB.`);
    const file = Platform.OS === 'web' ? asset.file : new File(asset.uri);
    if (!file) throw new Error('The selected image could not be read.');
    await validateImageFile(file);
    const response = await expoFetch(`${endpoint}?workspaceId=${encodeURIComponent(workspace.id)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: file });
    const result = await response.json() as { storageId?: Id<'_storage'>; error?: string };
    if (!response.ok || !result.storageId) throw new Error(result.error ?? 'The image upload failed. Try again.');
    if (!mounted.current) return;
    const url = await addImage({ pageId, file: result.storageId });
    if (mounted.current) { const request = Date.now(); pendingImage.current = request; setImage({ url, request }); }
  });
  if (!drafts.ready) return drafts.error ? <ErrorState layout="screen" message={drafts.error} onRetry={() => void drafts.reload()} /> : <Loading label="Checking recovery drafts…" />;
  if (drafts.restored.length) return <View style={{ flex: 1 }}>
    {dialog}
    {restoredPreview && <RecoveryPreview snapshot={restoredPreview.snapshot} identity={`${pageId}:${restoredPreview.id}`} onClose={() => setRestoredPreview(undefined)} />}
    {drafts.error && <ErrorState message={drafts.error} />}
    <EmptyState title="Unsaved draft found" description="A local copy from an earlier editing session is available. Review and copy anything you need before opening the shared document." action={<Stack style={{ alignItems: 'center' }}>
      {drafts.restored.map((copy, index) => <Button key={copy.id} label={drafts.restored.length === 1 ? 'Review unsaved draft' : `Review draft ${index + 1}`} disabled={recoveryTask.busy} onPress={() => setRestoredPreview(copy)} />)}
      <Button label="Open saved document" variant="secondary" loading={recoveryTask.busy} onPress={() => void recoveryTask.run(async () => {
        if (await confirm({ title: 'Discard recovery drafts?', body: 'These local copies will be removed from this device. Copy anything you need first.', action: 'Discard', danger: true })) await drafts.discard(drafts.restored.map(copy => copy.id));
      })} />
    </Stack>} />
  </View>;
  if (snapshot === undefined || version === undefined) return <Loading label="Opening editor…" />;
  if (!snapshot.content || version === null) return <EmptyState title="Document unavailable" />;
  return <View style={{ flex: 1, minHeight: 0 }}>
    {dialog}
    {actions.dialog}
    {reviewing && recovery && <RecoveryPreview snapshot={recovery} identity={pageId} onClose={() => setReviewing(false)} />}
    {(error || upload.error || drafts.error) && <ErrorState message={error ?? upload.error ?? drafts.error!} onRetry={error ? () => setRetry(n => n + 1) : undefined} />}
    {referenceIds.map((id) => <PageReference key={id} id={id} onChange={setReference} />)}
    <DocumentSurface onRecoverySnapshot={drafts.publish} onInterrupted={() => { if (latestDraft.current) setRecovery(latestDraft.current); }} onReviewDraft={recovery ? () => setReviewing(true) : undefined} onReadyChange={setEditorReady} onFormatting={async value => { if (mounted.current) setFormatting(value); }} onReloadSaved={async () => {
      if (upload.busy || actions.busy) return false;
      const reload = await confirm({ title: 'Reload saved document?', body: recovery ? 'The recovery copy of your unsaved draft will be discarded. Copy it first if you need to keep it. Pending images must be added again.' : 'Edits that were still saving may be lost. Any pending image will need to be added again.', action: 'Reload', danger: true });
      if (!reload || !mounted.current) return false;
      if (!await drafts.discard([drafts.owner])) return false;
      setRecovery(undefined); setReviewing(false);
      pendingImage.current = undefined; setImage(undefined); setCommand(undefined); setDirty(false); setError(undefined); setFormatting(undefined);
      return true;
    }} protectedWork={dirty || !!recovery || imageBusy || actions.busy} payload={encodeDocumentPayload({ pageId, snapshot, latestVersion: version, retrySignal: `${connection.connectionCount}:${retry}`, editable, canCreatePage: standalone, command, dark: theme.dark, fontScale: documentFontScale(Platform.OS, fontScale), colors: theme.colors, image, references })} onBlockActions={actions.onBlockActions} onCreatePage={actions.onCreatePage} onEditLink={actions.onEditLink}
      getSteps={(atVersion) => convex.query(api.pageSync.getSteps, { id: pageId, version: atVersion })}
      submitSteps={(args: Submit) => {
        if (!editable) return Promise.reject(new Error('This document is read only.'));
        return convex.mutation(api.pageSync.submitSteps, boundDocumentSteps(pageId, args));
      }}
      onReferences={async (ids) => { setReferenceIds(ids); }} onStatus={status} onRemovePages={removePages}
      onImageResult={async (request, unsaved, message) => {
        if (!mounted.current || pendingImage.current !== request) return;
        pendingImage.current = undefined;
        setDirty(unsaved); setImage(undefined);
        if (message) setError(message);
      }}
      onOpenLink={async (href) => {
        await openContentLink(href).catch((e: unknown) => setError(errorMessage(e)));
      }}
      dom={{ style: { flex: 1, minHeight: 0 }, hideKeyboardAccessoryView: true, scrollEnabled: true, contentInsetAdjustmentBehavior: 'never', automaticallyAdjustContentInsets: false }} />
    {editable && <DocumentToolbar formatting={formatting} busy={!editorReady || imageBusy || actions.busy} status={upload.busy ? 'Uploading image…' : image ? 'Adding image…' : dirty ? drafts.persisted && Platform.OS !== 'web' ? 'Saved on device. Waiting to sync…' : 'Saving changes…' : undefined} canCreate={standalone} onCommand={sendCommand} onImage={source => void pickImage(source)} />}
  </View>;
}

function PageReference({ id, onChange }: { id: string; onChange: (id: string, value: Reference) => void }) {
  const page = useQuery(api.pages.get, { pageId: id });
  useEffect(() => { if (page !== undefined) onChange(id, page ? { title: page.title, archived: page.archived } : null); }, [id, page, onChange]);
  return null;
}

export function VersionDocument({ content, identity }: { content: string; identity: string }) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [references, setReferences] = useState<Record<string, Reference>>({});
  const setReference = useCallback((id: string, value: Reference) => setReferences(previous => ({ ...previous, [id]: value })), []);
  return <View style={{ flex: 1, minHeight: 0 }}>
    {referenceIds.map(id => <PageReference key={id} id={id} onChange={setReference} />)}
    <DocumentSurface key={identity} payload={encodeDocumentPayload({ pageId: identity, snapshot: { content, version: 1 }, latestVersion: 1, editable: false, canCreatePage: false, dark: theme.dark, fontScale: documentFontScale(Platform.OS, fontScale), colors: theme.colors, references })} onBlockActions={async () => null} onCreatePage={async () => null}
    getSteps={async () => ({ steps: [], clientIds: [], version: 1 })} submitSteps={async () => { throw new Error('History is read only.'); }}
    onReferences={async ids => setReferenceIds(ids)} onStatus={async () => {}} onRemovePages={async () => false}
    onImageResult={async () => {}}
    onOpenLink={openContentLink}
    dom={{ style: { flex: 1, minHeight: 0 }, hideKeyboardAccessoryView: true, scrollEnabled: true, contentInsetAdjustmentBehavior: 'never', automaticallyAdjustContentInsets: false }} /></View>;
}


function RecoveryPreview({ snapshot, identity, onClose }: { snapshot: RecoverySnapshot; identity: string; onClose: () => void }) {
  const task = useTask();
  const [copied, setCopied] = useState(false);
  const [previewHeight, setPreviewHeight] = useState(0);
  return <EditorSheet title="Unsaved draft" scroll={false} onClose={onClose} busy={task.busy}>
    <Text variant="supporting" tone="muted">This recovery copy may include changes that have already saved. Copy what you need before reloading the shared document.</Text>
    <View style={{ flex: 1, minHeight: 0 }} onLayout={event => setPreviewHeight(event.nativeEvent.layout.height)}>
      {previewHeight > 0 && <View style={{ height: previewHeight }}><VersionDocument content={snapshot.content} identity={`${identity}:recovery`} /></View>}
    </View>
    {task.error && <ErrorState message={task.error} />}
    <Button label={copied ? 'Draft copied' : 'Copy draft'} loading={task.busy} onPress={() => void task.run(async () => {
      const copied = await setStringAsync(snapshot.html || snapshot.text, { inputFormat: snapshot.html ? StringFormat.HTML : StringFormat.PLAIN_TEXT });
      if (!copied) throw new Error('Could not copy the draft. Try again.');
      setCopied(true);
    })} />
  </EditorSheet>;
}
