import { getMarkRange } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { normalizeDocumentLink, unsupportedDocumentLink } from './documentLink';
import type { PageEditor } from './schema';

export type LinkDraft = { url: string; text: string };

/** Map the captured range through collaboration while the native form owns focus. */
export async function editDocumentLink(editor: PageEditor, edit: (draft: LinkDraft) => Promise<LinkDraft | null>, signal: AbortSignal) {
  if (!editor.isEditable || signal.aborted) return;
  const pm = editor._tiptapEditor;
  const url = editor.getSelectedLinkUrl() ?? '';
  const range = pm.state.selection.empty && url ? getMarkRange(pm.state.selection.$from, pm.state.schema.marks.link) : undefined;
  const selection = range ? TextSelection.create(pm.state.doc, range.from, range.to) : pm.state.selection;
  const text = pm.state.doc.textBetween(selection.from, selection.to, '\n');
  let bookmark = selection.getBookmark();
  const map = ({ transaction }: { transaction: Transaction }) => { bookmark = bookmark.map(transaction.mapping); };
  pm.on('transaction', map);
  editor.blur();
  try {
    const result = await edit({ url, text });
    if (!result || signal.aborted || pm.isDestroyed || !editor.isEditable) return;
    if (typeof result.url !== 'string' || typeof result.text !== 'string') throw new Error(unsupportedDocumentLink);
    const href = result.url === '' ? '' : normalizeDocumentLink(result.url);
    if (href === null) throw new Error(unsupportedDocumentLink);
    const restored = bookmark.resolve(pm.state.doc);
    // A collaborator may have removed the entire target while the sheet was open.
    if (!selection.empty && restored.empty) throw new Error('The selected text was removed. Select text and add the link again.');
    pm.view.dispatch(pm.state.tr.setSelection(restored));
    if (!href) pm.view.dispatch(pm.state.tr.removeMark(restored.from, restored.to, pm.state.schema.marks.link));
    else editor.createLink(href, result.text === text && !restored.empty ? undefined : result.text || href);
    editor.focus();
  } finally { pm.off('transaction', map); }
}
