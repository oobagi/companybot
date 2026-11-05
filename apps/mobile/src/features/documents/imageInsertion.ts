import type { PageEditor } from './schema';

/** Acknowledge each upload once, including failures and access changes. */
export function createImageInsertion() {
  let inserted: number | undefined;
  return (editor: PageEditor, image: { request: number; url: string } | undefined, editable: boolean) => {
    if (!image || inserted === image.request) return;
    inserted = image.request;
    let error: string | null = null;
    try {
      if (!editable) throw new Error('This document is now read only. The image could not be added.');
      const cursor = editor.getTextCursorPosition();
      editor.insertBlocks([{ type: 'image', props: { url: image.url } }], cursor.block, 'after');
    } catch (problem) { error = problem instanceof Error ? problem.message : String(problem); }
    return { request: image.request, error };
  };
}
