'use dom';

import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs, docToBlocks, filterSuggestionItems } from '@blocknote/core';
import { createReactBlockSpec, getDefaultReactSlashMenuItems, SuggestionMenuController } from '@blocknote/react';
import { BlockNoteView, darkDefaultTheme, lightDefaultTheme } from '@blocknote/mantine';
import '@blocknote/mantine/style.css';
import { pageBlockConfig } from '@companybot/core/page-block-config';
import { linkedPageId, pageHref, validPageHref } from '@companybot/core/page-links';
import { sendableSteps } from 'prosemirror-collab';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DOMProps } from 'expo/dom';
import { api } from '@/lib/api';
import type { Colors } from '@/design';
import { radii, sizes, spacing, typography } from '@/design/tokens';
import { createSyncTransport, type EditorTransport, type Snapshot } from './transport';
import { createEditorLifetime } from './lifetime';
import { documentSyncExtension } from './sync';
import './editor.css';

export type Reference = { title: string; archived: boolean } | null;
const References = createContext<Record<string, Reference>>({});
const pageSpec = createReactBlockSpec(pageBlockConfig, {
  render: function PageBlock({ block }) {
    const pages = useContext(References);
    const page = pages[block.props.pageId];
    return <a className="mobile-page-link" href={pageHref(block.props.pageId)} contentEditable={false}>
      <span aria-hidden>▤</span><span>{page?.title ?? block.props.title}</span>{page?.archived && <small>Archived</small>}{page === null && <small>Unavailable</small>}
    </a>;
  },
  toExternalHTML: ({ block }) => <a href={pageHref(block.props.pageId)}>{block.props.title}</a>,
})();
const schema = BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, page: pageSpec } });

type Props = EditorTransport & {
  dom?: DOMProps;
  pageId: string;
  snapshot: Snapshot;
  latestVersion: number | null;
  retrySignal?: string;
  editable: boolean;
  dark: boolean;
  colors: Colors;
  references: Record<string, Reference>;
  onReferences: (ids: string[]) => Promise<void>;
  onOpenLink: (href: string) => Promise<void>;
  onRemovePages: (ids: string[]) => Promise<boolean>;
  onStatus: (dirty: boolean, error: string | null) => Promise<void>;
  image?: { url: string; request: number };
};

export default function DocumentDOM(props: Props) {
  const latest = useRef(props);
  useEffect(() => { latest.current = props; }, [props]);
  const [problem, setProblem] = useState<string>();
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
      }, { onSyncError: (error) => { setProblem(error.message); void props.onStatus(!!sendableSteps(instance._tiptapEditor.state), error.message); } })] },
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
      if (joined !== previousRefs) { previousRefs = joined; void latest.current.onReferences([...ids]); }
    };
    const reportStatus = () => {
      const dirty = !!sendableSteps(editor._tiptapEditor.state);
      if (dirty === previousDirty) return;
      previousDirty = dirty;
      if (!dirty) setProblem(undefined);
      void latest.current.onStatus(dirty, null);
    };
    // Scan the block tree after a burst of document changes, never for selection-only transactions.
    const off = editor.onChange(() => { clearTimeout(referenceTimer); referenceTimer = setTimeout(reportReferences, 150); });
    // Acknowledgements can change collab state without changing the document.
    editor._tiptapEditor.on('transaction', reportStatus);
    reportReferences(); reportStatus();
    return () => { clearTimeout(referenceTimer); off(); editor._tiptapEditor.off('transaction', reportStatus); };
  }, [editor]);
  useEffect(() => {
    if (!editor || !props.editable) return;
    let approved = false;
    let asking = false;
    return editor.onBeforeChange(({ getChanges, tr }) => {
      if (approved || tr.getMeta('addToHistory') === false || tr.getMeta('rebased') !== undefined) return;
      const changes = getChanges();
      const pageIds = changes.flatMap((change) => change.type === 'delete' && change.block.type === 'page' ? [change.block.props.pageId] : []);
      if (!pageIds.length) return;
      const deleted = changes.filter((change) => change.type === 'delete').map((change) => change.block.id);
      if (!asking) {
        asking = true;
        queueMicrotask(() => { void latest.current.onRemovePages(pageIds).then((confirmed) => {
          if (!confirmed) return;
          approved = true;
          try { const remaining = deleted.filter((id) => editor.getBlock(id)); if (remaining.length) editor.removeBlocks(remaining); }
          finally { approved = false; }
        }).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error))).finally(() => { asking = false; }); });
      }
      return false;
    });
  }, [editor, props.editable]);
  const inserted = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!editor || !props.editable || !props.image || inserted.current === props.image.request) return;
    inserted.current = props.image.request;
    const cursor = editor.getTextCursorPosition();
    editor.insertBlocks([{ type: 'image', props: { url: props.image.url } }], cursor.block, 'after');
  }, [editor, props.editable, props.image]);
  if (!editor) return <p role="status">This document is unavailable.</p>;
  const baseTheme = props.dark ? darkDefaultTheme : lightDefaultTheme;
  return <References.Provider value={props.references}>
    <div className="mobile-document" style={{ color: props.colors.text, background: props.colors.background, '--page-border': props.colors.border, '--page-link': props.colors.link, '--space-sm': `${spacing.sm}px`, '--space-md': `${spacing.md}px`, '--space-lg': `${spacing.lg}px`, '--space-footer': `${spacing.xxxl}px`, '--radius-md': `${radii.md}px`, '--touch': `${sizes.touch}px`, '--body-size': `${typography.body.fontSize}px`, '--caption-size': `${typography.caption.fontSize}px` } as React.CSSProperties}
      onClickCapture={(event) => {
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
        if (!anchor) return;
        event.preventDefault(); event.stopPropagation();
        const href = anchor.getAttribute('href') ?? '';
        if (linkedPageId(href) || /^(https?:|mailto:|tel:)/i.test(href)) void props.onOpenLink(href);
      }}>
      {problem && <p role="alert">Your changes have not synced: {problem}</p>}
      <BlockNoteView editor={editor} editable={props.editable} theme={{ ...baseTheme, fontFamily: 'system-ui, sans-serif', colors: { ...baseTheme.colors, editor: { text: props.colors.text, background: props.colors.background } } }} sideMenu={false} slashMenu={false} filePanel={false}>
        <SuggestionMenuController triggerCharacter="/" getItems={async (query) => filterSuggestionItems(getDefaultReactSlashMenuItems(editor).filter((item) => !(['image', 'video', 'audio', 'file'] as const).some((type) => item.title === editor.dictionary.slash_menu[type].title)), query)} />
      </BlockNoteView>
    </div>
  </References.Provider>;
}
