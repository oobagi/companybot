import type { PageEditor } from './schema';

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
  const off = editor.onBeforeChange(({ getChanges, tr }) => {
    if (approved || tr.getMeta('addToHistory') === false || tr.getMeta('rebased') !== undefined) return;
    const changes = getChanges();
    const pageIds = changes.flatMap(change => change.type === 'delete' && change.block.type === 'page' ? [change.block.props.pageId] : []);
    if (!pageIds.length) return;
    const deleted = changes.filter(change => change.type === 'delete').map(change => change.block.id);
    if (!asking) {
      asking = true;
      queueMicrotask(() => {
        if (!active) { asking = false; return; }
        void confirm(pageIds).then(confirmed => {
          if (!confirmed || !active || editor._tiptapEditor.isDestroyed) return;
          approved = true;
          try {
            const remaining = new Set(deleted.filter(id => editor.getBlock(id)));
            // Removing a parent already removes its descendants. BlockNote rejects
            // a second descendant id after it has removed that whole subtree.
            const roots = [...remaining].filter(id => {
              let parent = editor.getParentBlock(id);
              while (parent) { if (remaining.has(parent.id)) return false; parent = editor.getParentBlock(parent.id); }
              return true;
            });
            if (roots.length) editor.removeBlocks(roots);
          }
          finally { approved = false; }
        }).catch(error => { if (active) fail(error); }).finally(() => { asking = false; });
      });
    }
    return false;
  });
  return () => { active = false; off(); };
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
