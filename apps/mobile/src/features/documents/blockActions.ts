import type { PageEditor } from './schema';
import type { Transaction } from '@tiptap/pm/state';

export type BlockAction = 'up' | 'down' | 'indent' | 'outdent' | 'before' | 'after' | 'delete' | 'page';
export type BlockTarget = { id: string; type: string; up: boolean; down: boolean; indent: boolean; outdent: boolean };

export function blockTarget(editor: PageEditor, id: string): BlockTarget {
  const block = editor.getBlock(id);
  if (!block) throw new Error('This block was removed. Select another block.');
  const parent = editor.getParentBlock(id);
  editor.setTextCursorPosition(id, 'end');
  return { id, type: block.type, up: !!editor.getPrevBlock(id) || !!parent, down: !!editor.getNextBlock(id) || !!parent, indent: editor.canNestBlock(), outdent: editor.canUnnestBlock() };
}

/** DOM payloads carry display/selection data only, never a document mutation scope. */
export function readBlockTarget(value: unknown): BlockTarget {
  if (!value || typeof value !== 'object') throw new Error('Invalid block action.');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || row.id.length > 256 || typeof row.type !== 'string' || row.type.length > 80 || ['up', 'down', 'indent', 'outdent'].some(key => typeof row[key] !== 'boolean') || Object.keys(row).some(key => !['id', 'type', 'up', 'down', 'indent', 'outdent'].includes(key))) throw new Error('Invalid block action.');
  return { id: row.id, type: row.type, up: row.up as boolean, down: row.down as boolean, indent: row.indent as boolean, outdent: row.outdent as boolean };
}

export function applyBlockAction(editor: PageEditor, id: string, action: Exclude<BlockAction, 'page'>) {
  if (!editor.isEditable) throw new Error('This document is read only.');
  if (!editor.getBlock(id)) throw new Error('This block was removed. Select another block.');
  if (action === 'up') editor.moveBlocksUp(id);
  else if (action === 'down') editor.moveBlocksDown(id);
  else if (action === 'delete') editor.removeBlocks([id]); // Existing page-removal guard owns confirmation.
  else if (action === 'before' || action === 'after') {
    const [block] = editor.insertBlocks([{ type: 'paragraph' }], id, action);
    editor.setTextCursorPosition(block, 'start');
  } else {
    editor.setTextCursorPosition(id, 'end');
    if (action === 'indent' && editor.canNestBlock()) editor.nestBlock();
    if (action === 'outdent' && editor.canUnnestBlock()) editor.unnestBlock();
  }
  if (action !== 'delete') editor.focus();
}

/** One guard for keyboard, touch actions and block menus, including nested page blocks. */
export function installPageRemovalGuard(editor: PageEditor, confirm: (ids: string[]) => Promise<boolean>, fail: (error: unknown) => void) {
  let active = true;
  let approved = false;
  let asking = false;
  let stopTracking = () => {};
  const off = editor.onBeforeChange(({ tr }) => {
    if (approved || !tr.docChanged || tr.getMeta('addToHistory') === false || tr.getMeta('rebased') !== undefined) return;
    // This runs before BlockNote assigns IDs to newly typed/pasted blocks.
    // getChanges() converts those temporary nodes to blocks and throws. Only
    // inspect existing identities here; moves retain their IDs in the new doc.
    const retained = new Set<string>();
    tr.doc.descendants(node => {
      if (node.type.name === 'blockContainer' && typeof node.attrs.id === 'string') retained.add(node.attrs.id);
    });
    const pageIds: string[] = [];
    tr.before.descendants(node => {
      if (node.type.name !== 'blockContainer' || typeof node.attrs.id !== 'string' || retained.has(node.attrs.id)) return;
      if (node.firstChild?.type.name === 'page') pageIds.push(node.firstChild.attrs.pageId);
    });
    if (!pageIds.length) return;
    if (!asking) {
      asking = true;
      // The server archives child pages by removing their blocks too. Keep the
      // entire requested edit and map it over accepted changes while asking.
      const mapping = tr.mapping.invert();
      const track = ({ transaction, appendedTransactions = [] }: { transaction: Transaction; appendedTransactions?: Transaction[] }) => {
        for (const change of [transaction, ...appendedTransactions]) mapping.appendMapping(change.mapping);
      };
      editor._tiptapEditor.on('transaction', track);
      stopTracking = () => editor._tiptapEditor.off('transaction', track);
      queueMicrotask(() => {
        if (!active) { stopTracking(); asking = false; return; }
        void confirm(pageIds).then(confirmed => {
          if (!confirmed || !active || editor._tiptapEditor.isDestroyed || !editor.isEditable) return;
          stopTracking();
          const next = editor._tiptapEditor.state.tr;
          // Like collaborative rebasing: map each step from its original input
          // through intervening changes and the steps already replayed here.
          for (let index = 0, from = tr.steps.length; index < tr.steps.length; index++, from--) {
            const step = tr.steps[index].map(mapping.slice(from));
            if (!step || next.maybeStep(step).failed) throw new Error('The document changed while confirming. Your replacement was not applied. Retry the edit; any pages already archived remain in Archive.');
            mapping.appendMap(step.getMap(), from - 1);
          }
          // Never let rebasing turn approval for one page into removal of another.
          const remaining = new Set<string>();
          next.doc.descendants(node => { if (node.type.name === 'page') remaining.add(node.attrs.pageId); });
          next.before.descendants(node => {
            if (node.type.name === 'page' && !remaining.has(node.attrs.pageId) && !pageIds.includes(node.attrs.pageId)) {
              throw new Error('Another page was added while confirming. Retry the edit to review which pages will be archived.');
            }
          });
          next.setSelection(tr.selection.map(next.doc, mapping));
          if (tr.storedMarksSet) next.setStoredMarks(tr.storedMarks);
          approved = true;
          try {
            editor._tiptapEditor.view.dispatch(next.scrollIntoView());
          }
          finally { approved = false; }
        }).catch(error => { if (active) fail(error); }).finally(() => { stopTracking(); asking = false; });
      });
    }
    return false;
  });
  return () => { active = false; stopTracking(); off(); };
}

function findPage(editor: PageEditor, pageId: string) {
  let found: string | undefined;
  editor.forEachBlock(block => { if (block.type === 'page' && block.props.pageId === pageId) found = block.id; return !found; });
  return found;
}

/** Wait for the server-created link, never create a second local reference. */
export async function createPageAtBlock(editor: PageEditor, anchorId: string, create: () => Promise<string | null>, signal: AbortSignal, timeoutMs = 10_000) {
  if (signal.aborted || !editor.isEditable) return null;
  if (!editor.getBlock(anchorId)) throw new Error('This block was removed. Select another block.');
  const pageId = await create();
  if (!pageId || signal.aborted) return null;
  const blockId = await new Promise<string | null>((resolve, reject) => {
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (id: string | null, error?: Error) => { off(); clearTimeout(timer); signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(id); };
    const abort = () => finish(null);
    const check = () => { const id = findPage(editor, pageId); if (id) finish(id); };
    off = editor.onChange(check);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(null, new Error('Your page was created at the end of this document. Reopen it after syncing to move its block.')), timeoutMs);
    check();
  });
  if (!blockId || signal.aborted) return null;
  if (!editor.isEditable || !editor.getBlock(anchorId)) throw new Error('Your page was created at the end of this document. The original block is no longer editable.');
  // One transaction makes this a move, not a deletion/archive followed by an insertion.
  const block = editor.getBlock(blockId)!;
  if (editor.getNextBlock(anchorId)?.id !== blockId) editor.transact(() => { editor.removeBlocks([blockId]); editor.insertBlocks([block], anchorId, 'after'); });
  editor.setTextCursorPosition(blockId, 'end');
  return pageId;
}
