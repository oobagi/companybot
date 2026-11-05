// @vitest-environment happy-dom
import { BlockNoteEditor } from '@blocknote/core';
import { afterEach, expect, it, vi } from 'vitest';
import { documentSchema, type PageEditor } from './schema';
import { applyBlockAction, blockTarget, createPageAtBlock, installPageRemovalGuard, readBlockTarget } from './blockActions';
import { createActionRequests, type PendingAction } from './actionRequests';
import { createDocumentCommandReceiver } from './commands';

const editors: PageEditor[] = [];
function editor() {
  const value = BlockNoteEditor.create({ schema: documentSchema, initialContent: [{ id: 'a', type: 'paragraph', content: 'Before' }, { id: 'b', type: 'paragraph', content: 'After' }] });
  value.mount(document.createElement('div'));
  editors.push(value);
  return value;
}
afterEach(() => { for (const value of editors.splice(0)) value._tiptapEditor.destroy(); vi.useRealTimers(); });

it('allows newly typed blocks before BlockNote assigns their IDs', () => {
  const value = editor();
  const confirm = vi.fn(async () => true);
  const dispose = installPageRemovalGuard(value, confirm, error => { throw error; });
  const pm = value._tiptapEditor;
  const block = pm.schema.nodes.blockContainer.create(null, pm.schema.nodes.paragraph.create(null, pm.schema.text('New paragraph')));
  expect(() => pm.view.dispatch(pm.state.tr.insert(pm.state.doc.content.size - 1, block))).not.toThrow();
  expect(value.document.at(-1)?.content).toEqual([{ type: 'text', text: 'New paragraph', styles: {} }]);
  expect(value.document.at(-1)?.id).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  dispose();
});

it('still confirms page deletion when a paste also inserts a block without an ID', async () => {
  const value = editor();
  value.insertBlocks([{ id: 'child-block', type: 'page', props: { pageId: 'child' } }], 'b', 'after');
  const confirm = vi.fn(async () => false);
  const dispose = installPageRemovalGuard(value, confirm, error => { throw error; });
  const pm = value._tiptapEditor;
  let from = 0; let size = 0;
  pm.state.doc.descendants((node, pos) => { if (node.attrs.id === 'child-block') { from = pos; size = node.nodeSize; } });
  const replacement = pm.schema.nodes.blockContainer.create(null, pm.schema.nodes.paragraph.create(null, pm.schema.text('Pasted paragraph')));
  expect(() => pm.view.dispatch(pm.state.tr.replaceWith(from, from + size, replacement))).not.toThrow();
  await Promise.resolve();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(['child']);
  expect(value.getBlock('child-block')).toBeDefined();
  expect(value.document.map(block => block.id)).toEqual(['a', 'b', 'child-block']);
  dispose();
});

it('consumes native commands once and creates at the captured cursor despite later selection changes', async () => {
  const value = editor();
  value.setTextCursorPosition('a', 'end');
  const receive = createDocumentCommandReceiver();
  let finish!: (pageId: string) => void;
  const create = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  let pending: Promise<string | null> | undefined;
  const run = vi.fn(() => {
    pending = createPageAtBlock(value, value.getTextCursorPosition().block.id, create, new AbortController().signal);
  });
  receive({ kind: 'page', request: 1 }, true, run);
  receive({ kind: 'page', request: 1 }, true, run);
  value.setTextCursorPosition('b', 'end');
  value.insertBlocks([{ id: 'child-block', type: 'page', props: { pageId: 'child' } }], 'b', 'after');
  finish('child');
  await expect(pending).resolves.toBe('child');
  expect(value.document.map(block => block.id)).toEqual(['a', 'child-block', 'b']);
  expect(create).toHaveBeenCalledOnce();
  receive({ kind: 'page', request: 2 }, false, run);
  receive({ kind: 'page', request: 2 }, true, run);
  expect(run).toHaveBeenCalledOnce();
});

it('rejects scope-bearing bridge payloads and releases cancelled native requests without accepting stale callbacks', async () => {
  const target = { id: 'a', type: 'paragraph', up: false, down: true, indent: false, outdent: false };
  expect(readBlockTarget(target)).toEqual(target);
  expect(() => readBlockTarget({ ...target, pageId: 'foreign' })).toThrow('Invalid');
  expect(() => readBlockTarget({ ...target, down: 'true' })).toThrow('Invalid');
  let shown: PendingAction | undefined;
  const requests = createActionRequests(value => { shown = value; });
  const first = requests.request({ kind: 'block', target }); const stale = shown!;
  await expect(requests.request({ kind: 'create' })).resolves.toBeNull();
  requests.cancel(); await expect(first).resolves.toBeNull();
  const next = requests.request({ kind: 'create' });
  stale.finish('delete'); expect(shown?.request.kind).toBe('create');
  shown!.finish({ pageId: 'child' }); await expect(next).resolves.toEqual({ pageId: 'child' });
});

it('moves the captured block, preserves its identity and leaves page-removal confirmation untouched', async () => {
  const value = editor();
  value.insertBlocks([{ id: 'child-block', type: 'page', props: { pageId: 'child' } }], 'b', 'after');
  const confirm = vi.fn(async () => false);
  const dispose = installPageRemovalGuard(value, confirm, error => { throw error; });
  expect(blockTarget(value, 'child-block').up).toBe(true);
  applyBlockAction(value, 'child-block', 'up');
  expect(value.document.map(block => block.id)).toEqual(['a', 'child-block', 'b']);
  expect(confirm).not.toHaveBeenCalled();
  applyBlockAction(value, 'child-block', 'delete');
  await Promise.resolve();
  expect(confirm).toHaveBeenCalledWith(['child']);
  expect(value.getBlock('child-block')).toBeDefined();
  dispose();
});

it('moves one server-created reference to the captured position without archiving or duplicating it', async () => {
  const value = editor();
  const deleted: string[] = [];
  value.onBeforeChange(({ getChanges }) => { deleted.push(...getChanges().filter(change => change.type === 'delete' && change.block.type === 'page').map(change => change.block.id)); });
  const create = vi.fn(async () => { value.insertBlocks([{ id: 'child-block', type: 'page', props: { pageId: 'child' } }], 'b', 'after'); return 'child'; });
  await expect(createPageAtBlock(value, 'a', create, new AbortController().signal)).resolves.toBe('child');
  expect(value.document.map(block => block.id)).toEqual(['a', 'child-block', 'b']);
  expect(deleted).toEqual([]);
  expect(create).toHaveBeenCalledOnce();
});

it('preserves parent text when creation fails and preserves the server reference when its anchor disappears', async () => {
  const value = editor();
  await expect(createPageAtBlock(value, 'a', async () => { throw new Error('No permission'); }, new AbortController().signal)).rejects.toThrow('No permission');
  expect(value.document.map(block => block.id)).toEqual(['a', 'b']);
  await expect(createPageAtBlock(value, 'a', async () => { value.removeBlocks(['a']); value.insertBlocks([{ id: 'child-block', type: 'page', props: { pageId: 'child' } }], 'b', 'after'); return 'child'; }, new AbortController().signal)).rejects.toThrow('created at the end');
  expect(value.getBlock('child-block')).toBeDefined();
});

it('releases the document subscription when placement is cancelled or times out', async () => {
  const value = editor();
  const off = vi.fn();
  vi.spyOn(value, 'onChange').mockReturnValue(off);
  const controller = new AbortController();
  const pending = createPageAtBlock(value, 'a', async () => 'child', controller.signal);
  await Promise.resolve(); controller.abort();
  await expect(pending).resolves.toBeNull(); expect(off).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  const timed = createPageAtBlock(value, 'a', async () => 'other', new AbortController().signal, 100);
  const rejected = expect(timed).rejects.toThrow('created at the end');
  await vi.advanceTimersByTimeAsync(100); await rejected; expect(off).toHaveBeenCalledTimes(2);
});

it('does not apply a late page-removal confirmation after the editor guard unmounts', async () => {
  const value = editor();
  value.insertBlocks([{ id: 'child-block', type: 'page', props: { pageId: 'child' } }], 'b', 'after');
  let answer!: (value: boolean) => void;
  const dispose = installPageRemovalGuard(value, () => new Promise(resolve => { answer = resolve; }), error => { throw error; });
  applyBlockAction(value, 'child-block', 'delete'); await Promise.resolve();
  dispose(); answer(true); await Promise.resolve();
  expect(value.getBlock('child-block')).toBeDefined();
});

it('confirms deletion of a parent containing page blocks once and removes only the outermost blocks', async () => {
  const value = editor();
  value.insertBlocks([{ id: 'parent', type: 'paragraph', content: 'Parent', children: [{ id: 'nested-page', type: 'page', props: { pageId: 'child' } }] }], 'b', 'after');
  const confirm = vi.fn(async () => true);
  const fail = vi.fn();
  const dispose = installPageRemovalGuard(value, confirm, fail);
  applyBlockAction(value, 'parent', 'delete');
  await vi.waitFor(() => expect(value.getBlock('parent')).toBeUndefined());
  expect(confirm).toHaveBeenCalledExactlyOnceWith(['child']);
  expect(value.getBlock('nested-page')).toBeUndefined();
  expect(fail).not.toHaveBeenCalled();
  dispose();
});

it('places the child after a later collaborative update, then removes its subscription', async () => {
  const value = editor();
  const listen = vi.spyOn(value, 'onChange');
  const pending = createPageAtBlock(value, 'a', async () => 'child', new AbortController().signal);
  await Promise.resolve();
  expect(listen).toHaveBeenCalledOnce();
  value.insertBlocks([{ id: 'child-block', type: 'page', props: { pageId: 'child' } }], 'b', 'after');
  await expect(pending).resolves.toBe('child');
  expect(value.document.map(block => block.id)).toEqual(['a', 'child-block', 'b']);
});
