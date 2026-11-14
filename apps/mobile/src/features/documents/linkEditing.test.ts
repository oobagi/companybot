// @vitest-environment happy-dom
import { BlockNoteEditor } from '@blocknote/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, expect, it, vi } from 'vitest';
import { validPageHref } from '@companybot/core/page-links';
import { documentSchema, type PageEditor } from './schema';
import { editDocumentLink, type LinkDraft } from './linkEditing';

const editors: PageEditor[] = [];
function editor() {
  const value = BlockNoteEditor.create({ schema: documentSchema, links: { isValidLink: validPageHref }, initialContent: [{ id: 'a', type: 'paragraph', content: 'Selected text' }] });
  value.mount(document.createElement('div')); editors.push(value);
  const pm = value._tiptapEditor;
  let start = 0;
  pm.state.doc.descendants((node, position) => { if (node.isText) start = position; });
  pm.view.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, start, start + 8)));
  return value;
}
afterEach(() => { for (const value of editors.splice(0)) value._tiptapEditor.destroy(); });

it('saves bare website addresses as openable HTTPS links', async () => {
  const value = editor();
  await editDocumentLink(value, async () => ({ url: 'example.com', text: 'Selected' }), new AbortController().signal);
  expect(value.getBlock('a')?.content).toEqual([
    { type: 'link', href: 'https://example.com/', content: [{ type: 'text', text: 'Selected', styles: {} }] },
    { type: 'text', text: ' text', styles: {} },
  ]);
});

it.each(['ftp://example.com', '/relative/path', 'sms:+15551234567'])('rejects %s without changing the document or selection', async url => {
  const value = editor();
  const before = value.document;
  const selection = value._tiptapEditor.state.selection.toJSON();
  await expect(editDocumentLink(value, async () => ({ url, text: 'Replacement' }), new AbortController().signal)).rejects.toThrow('not supported');
  expect(value.document).toEqual(before);
  expect(value._tiptapEditor.state.selection.toJSON()).toEqual(selection);
});

it('keeps the selected range through remote inserts while the native form is open', async () => {
  const value = editor();
  let finish!: (result: LinkDraft | null) => void;
  const edit = vi.fn(() => new Promise<LinkDraft | null>(resolve => { finish = resolve; }));
  const pending = editDocumentLink(value, edit, new AbortController().signal);
  expect(edit).toHaveBeenCalledExactlyOnceWith({ url: '', text: 'Selected' });
  const pm = value._tiptapEditor;
  pm.view.dispatch(pm.state.tr.insertText('Remote ', pm.state.selection.from).setMeta('addToHistory', false));
  finish({ url: 'https://example.com', text: 'Selected' });
  await pending;
  expect(value.getBlock('a')?.content).toEqual([
    { type: 'text', text: 'Remote ', styles: {} },
    { type: 'link', href: 'https://example.com', content: [{ type: 'text', text: 'Selected', styles: {} }] },
    { type: 'text', text: ' text', styles: {} },
  ]);
});

it('changes an existing link at the caret and removes its mark without deleting text', async () => {
  const value = editor();
  await editDocumentLink(value, async () => ({ url: 'https://example.com', text: 'Selected' }), new AbortController().signal);
  const pm = value._tiptapEditor;
  let linkAt = 0;
  pm.state.doc.descendants((node, position) => { if (node.isText && node.marks.some(mark => mark.type.name === 'link')) linkAt = position; });
  pm.view.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, linkAt + 2)));
  const edit = vi.fn(async () => ({ url: 'companybot://record/record1', text: 'Selected' }));
  await editDocumentLink(value, edit, new AbortController().signal);
  expect(edit).toHaveBeenCalledExactlyOnceWith({ url: 'https://example.com', text: 'Selected' });
  expect(value.getBlock('a')?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'link', href: 'companybot://record/record1' })]));
  await editDocumentLink(value, async draft => ({ ...draft, url: '' }), new AbortController().signal);
  expect(value.getBlock('a')?.content).toEqual([{ type: 'text', text: 'Selected text', styles: {} }]);
});

it('cancel, permission loss, removed text and unsafe protocols never overwrite content', async () => {
  const value = editor();
  const before = value.document;
  await editDocumentLink(value, async () => null, new AbortController().signal);
  expect(value.document).toEqual(before);
  await expect(editDocumentLink(value, async () => ({ url: 'javascript:alert(1)', text: 'bad' }), new AbortController().signal)).rejects.toThrow('supported');
  expect(value.document).toEqual(before);
  await editDocumentLink(value, async () => { value.isEditable = false; return { url: 'https://example.com', text: 'Selected' }; }, new AbortController().signal);
  expect(value.document).toEqual(before);
  value.isEditable = true;
  await expect(editDocumentLink(value, async () => {
    const pm = value._tiptapEditor;
    pm.view.dispatch(pm.state.tr.deleteSelection());
    return { url: 'https://example.com', text: 'Selected' };
  }, new AbortController().signal)).rejects.toThrow('removed');
  expect(value.getBlock('a')?.content).toEqual([{ type: 'text', text: ' text', styles: {} }]);
});
