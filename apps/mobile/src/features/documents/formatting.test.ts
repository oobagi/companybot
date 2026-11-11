// @vitest-environment happy-dom
import { BlockNoteEditor } from '@blocknote/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, expect, it } from 'vitest';
import { documentSchema, type PageEditor } from './schema';
import { applyDocumentFormat, documentFormatting } from './formatting';
import { createDocumentCommandReceiver } from './commands';

const editors: PageEditor[] = [];
function editor() {
  const value = BlockNoteEditor.create({ schema: documentSchema, initialContent: [
    { id: 'a', type: 'paragraph', content: 'Selected text' },
    { id: 'b', type: 'paragraph', content: 'Other paragraph' },
  ] });
  value.mount(document.createElement('div'));
  editors.push(value);
  return value;
}
afterEach(() => { for (const value of editors.splice(0)) value._tiptapEditor.destroy(); });

it('formats exactly the selected text after native controls take focus and reports the selected styles', () => {
  const value = editor();
  const pm = value._tiptapEditor;
  let position = 0;
  pm.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Selected text') position = pos; });
  pm.view.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, position, position + 8)));
  value.blur();
  const before = { from: pm.state.selection.from, to: pm.state.selection.to };
  applyDocumentFormat(value, 'style:bold');
  applyDocumentFormat(value, 'style:italic');
  applyDocumentFormat(value, 'style:underline');
  expect(value.getBlock('a')?.content).toEqual([
    { type: 'text', text: 'Selected', styles: { bold: true, italic: true, underline: true } },
    { type: 'text', text: ' text', styles: {} },
  ]);
  expect({ from: pm.state.selection.from, to: pm.state.selection.to }).toEqual(before);
  expect(documentFormatting(value).styles).toMatchObject({ bold: true, italic: true, underline: true });
  expect(value.getBlock('b')?.content).toEqual([{ type: 'text', text: 'Other paragraph', styles: {} }]);
});

it('converts selected text blocks without replacing content, ids or inline marks', () => {
  const value = editor();
  value.setTextCursorPosition('a', 'end');
  applyDocumentFormat(value, 'text:heading2');
  expect(value.getBlock('a')).toMatchObject({ id: 'a', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Selected text', styles: {} }] });
  expect(documentFormatting(value).text).toBe('heading2');
  applyDocumentFormat(value, 'text:bulletListItem');
  expect(value.getBlock('a')).toMatchObject({ id: 'a', type: 'bulletListItem', content: [{ text: 'Selected text' }] });
  applyDocumentFormat(value, 'text:paragraph');
  applyDocumentFormat(value, 'align:center');
  expect(value.getBlock('a')).toMatchObject({ type: 'paragraph', props: { textAlignment: 'center' } });
  expect(value.getBlock('b')).toMatchObject({ type: 'paragraph', props: { textAlignment: 'left' } });
});

it('does not convert a selected image into text or modify a read-only document', () => {
  const value = editor();
  value.insertBlocks([{ id: 'image', type: 'image', props: { url: 'https://example.test/photo.png' } }], 'b', 'after');
  value.setTextCursorPosition('image');
  const withImage = value.document;
  expect(documentFormatting(value).canFormat).toBe(false);
  applyDocumentFormat(value, 'text:paragraph');
  expect(value.document).toEqual(withImage);
  value.setTextCursorPosition('a', 'end');
  value.isEditable = false;
  applyDocumentFormat(value, 'text:heading1');
  expect(value.document).toEqual(withImage);
});

it('does not replay a bootstrap formatting command after remount and applies later requests only once', () => {
  const value = editor();
  value.setTextCursorPosition('a', 'end');
  const receive = createDocumentCommandReceiver(5);
  const apply = () => applyDocumentFormat(value, 'style:bold');
  receive({ kind: 'style:bold', request: 5 }, true, apply);
  expect(documentFormatting(value).styles.bold).toBe(false);
  receive({ kind: 'style:bold', request: 6 }, true, apply);
  receive({ kind: 'style:bold', request: 6 }, true, apply);
  expect(documentFormatting(value).styles.bold).toBe(true);
  receive({ kind: 'style:bold', request: 7 }, false, apply);
  receive({ kind: 'style:bold', request: 7 }, true, apply);
  expect(documentFormatting(value).styles.bold).toBe(true);
});
