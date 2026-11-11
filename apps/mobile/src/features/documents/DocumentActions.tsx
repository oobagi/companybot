import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { normalizeDocumentLink, unsupportedDocumentLink } from './documentLink';
import type { LinkDraft } from './linkEditing';
import { Button, EditorSheet, ErrorState, Field, ListRow, Text } from '@/components/ui';
import { useTask } from '@/lib/useTask';
import { useDraftGuard } from '@/lib/useDraftGuard';
import { readBlockTarget, type BlockAction } from './blockActions';
import { createActionRequests, type ActionReply, type PendingAction } from './actionRequests';

export function useDocumentActions({ editable, available, canCreate, create }: { editable: boolean; available: boolean; canCreate: boolean; create: (title: string) => Promise<string> }) {
  const [pending, setPending] = useState<PendingAction>();
  const [requests] = useState(() => createActionRequests(setPending));
  useEffect(() => () => requests.cancel(), [requests]);
  useEffect(() => { if (!editable) requests.cancel(); }, [editable, requests]);
  return {
    busy: !!pending,
    onBlockActions: async (target: unknown): Promise<BlockAction | null> => {
      if (!editable || !available) return null;
      const reply = await requests.request({ kind: 'block', target: readBlockTarget(target) });
      return typeof reply === 'string' ? reply : null;
    },
    onCreatePage: async (): Promise<string | null> => {
      if (!editable || !available || !canCreate) return null;
      const reply = await requests.request({ kind: 'create' });
      return reply && typeof reply === 'object' && 'pageId' in reply ? reply.pageId : null;
    },
    onEditLink: async (draft: LinkDraft): Promise<LinkDraft | null> => {
      if (!editable || !available || typeof draft?.url !== 'string' || typeof draft?.text !== 'string') return null;
      const reply = await requests.request({ kind: 'link', draft });
      return reply && typeof reply === 'object' && 'url' in reply ? reply : null;
    },
    dialog: pending ? pending.request.kind === 'block' ? <BlockActions pending={pending} canCreate={canCreate} available={available} /> : pending.request.kind === 'link' ? <EditLink pending={pending} available={available} /> : <CreateChild pending={pending} create={create} available={available} /> : null,
  };
}

const interruptedMessage = 'The editor closed unexpectedly. Copy any text you need, then cancel and reload the document.';

function BlockActions({ pending, canCreate, available }: { pending: PendingAction; canCreate: boolean; available: boolean }) {
  const [closing, setClosing] = useState<{ value: ActionReply }>();
  if (pending.request.kind !== 'block') return null;
  const { target } = pending.request;
  const choose = (value: ActionReply) => { if (value === null || available) setClosing({ value }); };
  return <EditorSheet title="Block actions" size="content" open={!closing} busy={!!closing} onClose={() => { if (!closing) choose(null); }} onDismiss={() => pending.finish(closing?.value ?? null)}>
    {!available && <Text tone="danger" accessibilityRole="alert">{interruptedMessage}</Text>}
    <Text tone="muted">{target.type === 'page' ? 'Page block' : target.type.replace(/([a-z])([A-Z])/g, '$1 $2')}</Text>
    <ListRow title="Move up" disabled={!available || !target.up} onPress={() => choose('up')} />
    <ListRow title="Move down" disabled={!available || !target.down} onPress={() => choose('down')} />
    <ListRow title="Indent" disabled={!available || !target.indent} onPress={() => choose('indent')} />
    <ListRow title="Outdent" disabled={!available || !target.outdent} onPress={() => choose('outdent')} />
    <ListRow title="Add text before" disabled={!available} onPress={() => choose('before')} />
    <ListRow title="Add text after" disabled={!available} onPress={() => choose('after')} />
    {canCreate && <ListRow title="New page after this block" disabled={!available} onPress={() => choose('page')} />}
    <Button label={target.type === 'page' ? 'Remove page block…' : 'Delete block'} variant="danger" disabled={!available} onPress={() => choose('delete')} />
  </EditorSheet>;
}

function CreateChild({ pending, create, available }: { pending: PendingAction; create: (title: string) => Promise<string>; available: boolean }) {
  const [title, setTitle] = useState('');
  const [created, setCreated] = useState(false);
  const live = useRef(available);
  useLayoutEffect(() => { live.current = available; }, [available]);
  const [closing, setClosing] = useState<{ value: ActionReply }>();
  const task = useTask();
  const guard = useDraftGuard({ dirty: !!title && !created, busy: task.busy || !!closing, onClose: () => setClosing({ value: null }) });
  const submit = () => {
    if (!live.current || created) return;
    void task.run(async () => {
      const pageId = await create(title.trim() || 'Untitled');
      guard.complete(); setCreated(true);
      // A committed child remains in Pages even if its originating editor died.
      if (live.current) setClosing({ value: { pageId } });
    });
  };
  return <EditorSheet title="New sub-page" size="content" open={!closing} busy={task.busy || !!closing} dismissible={guard.dismissible} onClose={() => void guard.close()} onDismiss={() => pending.finish(closing?.value ?? null)} submit={created ? undefined : { label: 'Create', disabled: !available, onPress: submit }}>
    {guard.dialog}
    {created ? <Text accessibilityRole="alert">Your sub-page was created. Find it in Pages after reloading the document.</Text> : !available && <Text tone="danger" accessibilityRole="alert">{interruptedMessage}</Text>}
    <Field label="Title" value={title} onChangeText={setTitle} editable={!task.busy && !created} maxLength={500} autoFocus placeholder="Untitled" />
    {task.error && <ErrorState message={task.error} />}
  </EditorSheet>;
}


function EditLink({ pending, available }: { pending: PendingAction; available: boolean }) {
  if (pending.request.kind !== 'link') return null;
  return <LinkForm initial={pending.request.draft} finish={pending.finish} available={available} />;
}

function LinkForm({ initial, finish, available }: { initial: LinkDraft; finish: PendingAction['finish']; available: boolean }) {
  const [url, setUrl] = useState(initial.url);
  const [text, setText] = useState(initial.text);
  const [closing, setClosing] = useState<{ value: LinkDraft | null }>();
  const normalizedUrl = normalizeDocumentLink(url);
  const close = (value: LinkDraft | null) => setClosing({ value });
  const guard = useDraftGuard({ dirty: url !== initial.url || text !== initial.text, busy: !!closing, onClose: () => close(null) });
  return <EditorSheet title={initial.url ? 'Edit link' : 'Add link'} size="content" open={!closing} busy={!!closing} dismissible={guard.dismissible} onClose={() => void guard.close()} onDismiss={() => finish(closing?.value ?? null)} submit={{ disabled: !available || !normalizedUrl, onPress: () => { if (available && normalizedUrl) { guard.complete(); close({ url: normalizedUrl, text }); } } }}>
    {guard.dialog}
    {!available && <Text tone="danger" accessibilityRole="alert">{interruptedMessage}</Text>}
    <Field label="Text" value={text} onChangeText={setText} editable={!closing} placeholder="Use the link address" maxLength={10000} />
    <Field label="Link" value={url} onChangeText={setUrl} editable={!closing} autoFocus keyboardType="url" autoCapitalize="none" autoCorrect={false} placeholder="https://example.com" maxLength={4000} />
    {!!url.trim() && !normalizedUrl && <Text tone="danger" accessibilityRole="alert">{unsupportedDocumentLink}</Text>}
    {initial.url && <Button label="Remove link" variant="danger" disabled={!available || !!closing} onPress={() => { if (!available) return; guard.complete(); close({ url: '', text: initial.text }); }} />}
  </EditorSheet>;
}
