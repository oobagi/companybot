'use dom';

import { BlockNoteEditor, docToBlocks, filterSuggestionItems } from '@blocknote/core';
import { getDefaultReactSlashMenuItems, SuggestionMenuController } from '@blocknote/react';
import { BlockNoteView, darkDefaultTheme, lightDefaultTheme } from '@blocknote/mantine';
// Metro does not reliably preserve the skin's nested package CSS imports.
import '@blocknote/core/style.css';
import '@blocknote/react/style.css';
import '@blocknote/mantine/style.css';
import { linkedPageId, pageHref, validPageHref } from '@companybot/core/page-links';
import { sendableSteps } from 'prosemirror-collab';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DOMProps } from 'expo/dom';
import { api } from '@/lib/api';
import { radii, sizes, spacing, typography } from '@/design/tokens';
import { createSyncTransport, type EditorTransport } from './transport';
import { createEditorLifetime } from './lifetime';
import { documentSyncExtension } from './sync';
import './editor.css';
import { documentSchema as schema, PageBlockActions, References } from './schema';
import { applyBlockAction, blockTarget, createPageAtBlock, installPageRemovalGuard, type BlockAction, type BlockTarget } from './blockActions';
import { createBridgeNotifications } from './bridgeNotifications';
import { createDocumentCommandReceiver } from './commands';
import { decodeDocumentPayload } from './domPayload';

type Props = EditorTransport & {
  dom?: DOMProps;
  payload: string;
  onBlockActions: (target: BlockTarget) => Promise<BlockAction | null>;
  onCreatePage: () => Promise<string | null>;
  onReferences: (ids: string[]) => Promise<void>;
  onOpenLink: (href: string) => Promise<void>;
  onRemovePages: (ids: string[]) => Promise<boolean>;
  onStatus: (dirty: boolean, error: string | null) => Promise<void>;
};

export default function DocumentDOM(wire: Props) {
  const native = process.env.EXPO_DOM_HOST_OS === 'ios' || process.env.EXPO_DOM_HOST_OS === 'android';
  useLayoutEffect(() => {
    if (!native) return;
    // Expo supplies this tag in its DOM HTML. Update it instead of adding a
    // second viewport tag; BlockNote needs the layout viewport above the keyboard.
    const existing = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const viewport = existing ?? document.createElement('meta');
    const before = viewport.content;
    viewport.name = 'viewport';
    const directives = (before || 'width=device-width, initial-scale=1').split(',').map(value => value.trim()).filter(value => !/^interactive-widget\s*=/.test(value));
    viewport.content = [...directives, 'interactive-widget=resizes-content'].join(', ');
    if (!existing) document.head.append(viewport);
    return () => { if (existing) viewport.content = before; else viewport.remove(); };
  }, [native]);
  const data = useMemo(() => decodeDocumentPayload(wire.payload), [wire.payload]);
  const props = useMemo(() => ({ ...wire, ...data }), [wire, data]);
  const latest = useRef(props);
  useEffect(() => { latest.current = props; }, [props]);
  const [problem, setProblem] = useState<string>();
  const [actionProblem, setActionProblem] = useState<string>();
  const [receiveCommand] = useState(createDocumentCommandReceiver);
  const [notifications] = useState(() => createBridgeNotifications(error => setActionProblem(error instanceof Error ? error.message : String(error))));
  useEffect(() => notifications.retain(), [notifications]);
  const action = useRef<AbortController | null>(null);
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => { if (!props.editable) action.current?.abort(); }, [props.editable]);
  const [transport] = useState(() => createSyncTransport(props.pageId, {
    getSteps: props.getSteps,
    submitSteps: props.submitSteps,
  }, props.latestVersion));
  useEffect(() => { transport.replaceCallbacks(props); }, [transport, props]);
  const editor = useMemo(() => {
    if (!props.snapshot.content) return null;
    const initial = JSON.parse(props.snapshot.content);
    const parser = BlockNoteEditor.create({ schema, _headless: true });
    const blocks = docToBlocks(parser.pmSchema.nodeFromJSON(initial));
    parser._tiptapEditor.destroy();
    const instance = BlockNoteEditor.create({
      schema,
      initialContent: blocks,
      links: { isValidLink: validPageHref, onClick: () => true },
      _tiptapOptions: { extensions: [documentSyncExtension(transport.client, props.pageId, api.pageSync, {
        initialContent: initial, initialVersion: props.snapshot.version,
      }, { onSyncError: (error) => { setProblem(error.message); void notifications.send(() => props.onStatus(!!sendableSteps(instance._tiptapEditor.state), error.message)); } })] },
    });
    return instance;
    // This component is keyed by document/version-preview identity; never reset local edits on remote props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const lifetime = useMemo(() => createEditorLifetime(() => editor?._tiptapEditor.destroy()), [editor]);
  // BlockNoteView only unmounts its view. Destroy also releases the sync extension
  // and performs its best-effort final flush; a same-tick StrictMode remount cancels it.
  useEffect(() => lifetime.retain(), [lifetime]);
  useEffect(() => { transport.update(props.latestVersion); }, [props.latestVersion, transport]);
  useEffect(() => { transport.retry(); }, [props.retrySignal, transport]);
  useEffect(() => {
    if (!editor) return;
    let previousRefs = '';
    let previousDirty: boolean | undefined;
    let referenceTimer: ReturnType<typeof setTimeout> | undefined;
    const reportReferences = () => {
      const ids = new Set<string>();
      editor.forEachBlock((block) => { if (block.type === 'page') ids.add(block.props.pageId); return true; });
      const joined = [...ids].sort().join(',');
      if (joined !== previousRefs) { previousRefs = joined; void notifications.send(() => latest.current.onReferences([...ids])); }
    };
    const reportStatus = () => {
      const dirty = !!sendableSteps(editor._tiptapEditor.state);
      if (dirty === previousDirty) return;
      previousDirty = dirty;
      if (!dirty) setProblem(undefined);
      void notifications.send(() => latest.current.onStatus(dirty, null));
    };
    // Scan the block tree after a burst of document changes, never for selection-only transactions.
    const off = editor.onChange(() => { clearTimeout(referenceTimer); referenceTimer = setTimeout(reportReferences, 150); });
    // Acknowledgements can change collab state without changing the document.
    editor._tiptapEditor.on('transaction', reportStatus);
    reportReferences(); reportStatus();
    return () => { clearTimeout(referenceTimer); off(); editor._tiptapEditor.off('transaction', reportStatus); };
  }, [editor, notifications]);
  useEffect(() => {
    if (!editor || !props.editable) return;
    return installPageRemovalGuard(editor, ids => latest.current.onRemovePages(ids), error => setActionProblem(error instanceof Error ? error.message : String(error)));
  }, [editor, props.editable]);
  const inserted = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!editor || !props.editable || !props.image || inserted.current === props.image.request) return;
    inserted.current = props.image.request;
    const cursor = editor.getTextCursorPosition();
    editor.insertBlocks([{ type: 'image', props: { url: props.image.url } }], cursor.block, 'after');
  }, [editor, props.editable, props.image]);
  const perform = useCallback(async (id: string, creating = false) => {
    if (!editor || !latest.current.editable || action.current) return;
    const controller = new AbortController(); action.current = controller;
    setActionProblem(undefined);
    try {
      const target = blockTarget(editor, id);
      editor.blur();
      const chosen = creating ? 'page' : await latest.current.onBlockActions(target);
      if (!chosen || controller.signal.aborted || !latest.current.editable) return;
      if (chosen === 'page') {
        if (!latest.current.canCreatePage) return;
        const pageId = await createPageAtBlock(editor, id, () => latest.current.onCreatePage(), controller.signal);
        if (pageId && !controller.signal.aborted) await latest.current.onOpenLink(pageHref(pageId));
      } else applyBlockAction(editor, id, chosen);
    } catch (error) { if (!controller.signal.aborted) setActionProblem(error instanceof Error ? error.message : String(error)); }
    finally { if (action.current === controller) action.current = null; }
  }, [editor]);
  useEffect(() => {
    if (!editor) return;
    receiveCommand(props.command, props.editable, kind => {
      // ProseMirror retains the DOM selection when focus moves to the native toolbar.
      void perform(editor.getTextCursorPosition().block.id, kind === 'page');
    });
  }, [editor, perform, props.command, props.editable, receiveCommand]);
  if (!editor) return <p role="status">This document is unavailable.</p>;
  const baseTheme = props.dark ? darkDefaultTheme : lightDefaultTheme;
  return <References.Provider value={props.references}><PageBlockActions.Provider value={props.editable ? id => { void perform(id); } : null}>
    <div className={`mobile-document${native ? ' native-document bn-scroll-container' : ''}`} style={{ color: props.colors.text, background: props.colors.background, '--page-border': props.colors.border, '--page-link': props.colors.link, '--space-sm': `${spacing.sm}px`, '--space-md': `${spacing.md}px`, '--space-lg': `${spacing.lg}px`, '--space-footer': `${spacing.xxxl}px`, '--radius-md': `${radii.md}px`, '--touch': `${sizes.touch}px`, '--body-size': `${typography.body.fontSize}px`, '--caption-size': `${typography.caption.fontSize}px` } as React.CSSProperties}
      onClickCapture={(event) => {
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!anchor) return;
        event.preventDefault(); event.stopPropagation();
        const href = anchor.getAttribute('href') ?? '';
        if (linkedPageId(href) || /^(https?:|mailto:|tel:)/i.test(href)) void notifications.send(() => latest.current.onOpenLink(href));
      }}>
      {problem && <p role="alert">Your changes have not synced: {problem}</p>}
      {actionProblem && <p role="alert">{actionProblem}</p>}
      <BlockNoteView editor={editor} editable={props.editable} theme={{ ...baseTheme, fontFamily: 'system-ui, sans-serif', colors: { ...baseTheme.colors, editor: { text: props.colors.text, background: props.colors.background } } }} sideMenu={false} slashMenu={false} filePanel={false}>
        <SuggestionMenuController triggerCharacter="/" getItems={async (query) => filterSuggestionItems([
          ...getDefaultReactSlashMenuItems(editor).filter((item) => !(['image', 'video', 'audio', 'file'] as const).some((type) => item.title === editor.dictionary.slash_menu[type].title)),
          ...(props.canCreatePage ? [{ title: 'Page', subtext: 'Add a page inside', aliases: ['page', 'subpage'], group: 'Pages', onItemClick: () => { void perform(editor.getTextCursorPosition().block.id, true); } }] : []),
        ], query)} />
      </BlockNoteView>
    </div>
  </PageBlockActions.Provider></References.Provider>;
}
