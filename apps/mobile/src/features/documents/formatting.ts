import type { PageEditor } from './schema';

export type InlineFormat = 'bold' | 'italic' | 'underline' | 'strike' | 'code';
export type TextBlockFormat = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'bulletListItem' | 'numberedListItem' | 'checkListItem' | 'quote';
export type FormatCommand = `style:${InlineFormat}` | `text:${TextBlockFormat}` | `align:${'left' | 'center' | 'right'}`;
export type DocumentFormatting = {
  styles: Record<InlineFormat, boolean>;
  text: TextBlockFormat | null;
  canFormat: boolean;
  alignment: string | null;
  up: boolean;
  down: boolean;
  indent: boolean;
  outdent: boolean;
};

function selectedBlocks(editor: PageEditor) {
  return editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];
}
function textFormat(block: PageEditor['document'][number]): TextBlockFormat | null {
  if (block.type === 'heading') return `heading${block.props.level}` as TextBlockFormat;
  return ['paragraph', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote'].includes(block.type) ? block.type as TextBlockFormat : null;
}

/** Read the mapped ProseMirror selection without moving it to a block boundary. */
export function documentFormatting(editor: PageEditor): DocumentFormatting {
  const active = editor.getActiveStyles();
  const blocks = selectedBlocks(editor);
  const first = blocks[0];
  const text = textFormat(first);
  const alignment = 'textAlignment' in first.props ? first.props.textAlignment : null;
  const cursor = editor.getTextCursorPosition().block;
  const parent = editor.getParentBlock(cursor.id);
  return {
    styles: { bold: !!active.bold, italic: !!active.italic, underline: !!active.underline, strike: !!active.strike, code: !!active.code },
    text: blocks.every(block => textFormat(block) === text) ? text : null,
    canFormat: blocks.every(block => textFormat(block) !== null),
    alignment: blocks.every(block => 'textAlignment' in block.props && block.props.textAlignment === alignment) ? alignment : null,
    up: !!editor.getPrevBlock(cursor.id) || !!parent,
    down: !!editor.getNextBlock(cursor.id) || !!parent,
    indent: editor.canNestBlock(),
    outdent: editor.canUnnestBlock(),
  };
}

/** Native menus take focus, but the editor's transaction selection stays mapped. */
export function applyDocumentFormat(editor: PageEditor, command: FormatCommand) {
  if (!editor.isEditable) return;
  const blocks = selectedBlocks(editor);
  if (!blocks.every(block => textFormat(block) !== null)) return;
  const [kind, value] = command.split(':');
  if (kind === 'style') editor.toggleStyles({ [value]: true });
  else editor.transact(() => {
    for (const block of blocks) {
      if (kind === 'align') editor.updateBlock(block, { props: { textAlignment: value as 'left' | 'center' | 'right' } });
      else if (value.startsWith('heading')) editor.updateBlock(block, { type: 'heading', props: { level: Number(value.slice(-1)) as 1 | 2 | 3 } });
      else editor.updateBlock(block, { type: value as Exclude<TextBlockFormat, 'heading1' | 'heading2' | 'heading3'> });
    }
  });
  editor.focus();
}
