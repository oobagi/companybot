import { SymbolView } from 'expo-symbols';
import { View } from 'react-native';
import { ActionMenu, type Action } from '@/components/ui/ActionMenu';
import { ContentToolbarFrame } from '@/components/ui/ContentToolbarFrame';
import { useTheme } from '@/design';
import Bold from '@expo/material-symbols/format_bold.xml';
import Italic from '@expo/material-symbols/format_italic.xml';
import Underline from '@expo/material-symbols/format_underlined.xml';
import Strike from '@expo/material-symbols/format_strikethrough.xml';
import Link from '@expo/material-symbols/link.xml';
import Code from '@expo/material-symbols/code.xml';
import Title from '@expo/material-symbols/title.xml';
import Bullets from '@expo/material-symbols/format_list_bulleted.xml';
import Numbers from '@expo/material-symbols/format_list_numbered.xml';
import Checklist from '@expo/material-symbols/checklist.xml';
import Quote from '@expo/material-symbols/format_quote.xml';
import Left from '@expo/material-symbols/format_align_left.xml';
import Center from '@expo/material-symbols/format_align_center.xml';
import Right from '@expo/material-symbols/format_align_right.xml';
import Image from '@expo/material-symbols/image.xml';
import Page from '@expo/material-symbols/note_add.xml';
import Up from '@expo/material-symbols/arrow_upward.xml';
import Down from '@expo/material-symbols/arrow_downward.xml';
import Indent from '@expo/material-symbols/format_indent_increase.xml';
import Outdent from '@expo/material-symbols/format_indent_decrease.xml';
import Add from '@expo/material-symbols/add.xml';
import Delete from '@expo/material-symbols/delete.xml';
import type { DocumentCommand } from './commands';
import type { DocumentFormatting, TextBlockFormat } from './formatting';

const icon = (ios: Extract<Action['icon'], string>, android: number): Action['icon'] => process.env.EXPO_OS === 'ios' ? ios : android;
const textFormats: [TextBlockFormat, string, Action['icon']][] = [
  ['paragraph', 'Paragraph', icon('text.alignleft', Left)],
  ['heading1', 'Heading 1', icon('textformat.size.larger', Title)],
  ['heading2', 'Heading 2', icon('textformat.size', Title)],
  ['heading3', 'Heading 3', icon('textformat.size.smaller', Title)],
  ['bulletListItem', 'Bulleted list', icon('list.bullet', Bullets)],
  ['numberedListItem', 'Numbered list', icon('list.number', Numbers)],
  ['checkListItem', 'Checklist', icon('checklist', Checklist)],
  ['quote', 'Quote', icon('text.quote', Quote)],
];

/** One native floating control bar; menus leave document selection in ProseMirror. */
export function DocumentToolbar({ formatting, busy, status, canCreate, onCommand, onImage }: {
  formatting?: DocumentFormatting;
  busy: boolean;
  status?: string;
  canCreate: boolean;
  onCommand: (kind: DocumentCommand['kind']) => void;
  onImage: (source: 'photos' | 'files') => void;
}) {
  const { colors, sizes } = useTheme();
  const textDisabled = busy || !formatting?.canFormat;
  const format: Action[] = [
    { id: 'text', title: 'Text style', icon: icon('textformat', Title), disabled: textDisabled, items: textFormats.map(([id, title, image]) => ({ id: `text:${id}`, title, icon: image, selected: formatting?.text === id })) },
    ...([
      ['bold', 'Bold', icon('bold', Bold)], ['italic', 'Italic', icon('italic', Italic)], ['underline', 'Underline', icon('underline', Underline)], ['strike', 'Strikethrough', icon('strikethrough', Strike)], ['code', 'Inline code', icon('chevron.left.forwardslash.chevron.right', Code)],
    ] as const).map(([id, title, image]) => ({ id: `style:${id}`, title, icon: image, selected: formatting?.styles[id] ?? false, disabled: textDisabled })),
    { id: 'link', title: 'Link…', icon: icon('link', Link), disabled: textDisabled },
    { id: 'alignment', title: 'Alignment', icon: icon('text.alignleft', Left), disabled: textDisabled, items: ([['left', 'Left', icon('text.alignleft', Left)], ['center', 'Center', icon('text.aligncenter', Center)], ['right', 'Right', icon('text.alignright', Right)]] as const).map(([id, title, image]) => ({ id: `align:${id}`, title, icon: image, selected: formatting?.alignment === id })) },
  ];
  const insert: Action[] = [
    { id: 'photos', title: 'Photo library', icon: icon('photo', Image), disabled: busy },
    { id: 'files', title: 'Choose image file', icon: icon('doc', Page), disabled: busy },
    ...(canCreate ? [{ id: 'page', title: 'Sub-page', icon: icon('doc.badge.plus', Page), disabled: busy }] : []),
  ];
  const blocks: Action[] = [
    { id: 'action:up', title: 'Move up', icon: icon('arrow.up', Up), disabled: busy || !formatting?.up },
    { id: 'action:down', title: 'Move down', icon: icon('arrow.down', Down), disabled: busy || !formatting?.down },
    { id: 'action:indent', title: 'Indent', icon: icon('increase.indent', Indent), disabled: busy || !formatting?.indent },
    { id: 'action:outdent', title: 'Outdent', icon: icon('decrease.indent', Outdent), disabled: busy || !formatting?.outdent },
    { id: 'action:before', title: 'Add text before', icon: icon('plus', Add), disabled: busy },
    { id: 'action:after', title: 'Add text after', icon: icon('plus', Add), disabled: busy },
    { id: 'action:delete', title: 'Delete block', icon: icon('trash', Delete), disabled: busy, destructive: true },
  ];
  const dispatch = (id: string) => { if (!busy) onCommand(id as DocumentCommand['kind']); };
  return <ContentToolbarFrame status={status} busy={busy} accessibilityLabel="Document editing">
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {process.env.EXPO_OS !== 'web' && <ActionMenu label="Format text" actions={format} onAction={dispatch}><SymbolView name={{ ios: 'textformat', android: 'text_format' }} size={sizes.icon} tintColor={textDisabled ? colors.muted : colors.text} /></ActionMenu>}
      <ActionMenu label="Insert" actions={insert} onAction={id => { if (!busy) { if (id === 'photos' || id === 'files') onImage(id); else onCommand('page'); } }}><SymbolView name={{ ios: 'plus', android: 'add' }} size={sizes.icon} tintColor={busy ? colors.muted : colors.text} /></ActionMenu>
      <ActionMenu label="Block actions" actions={blocks} onAction={dispatch}><SymbolView name={{ ios: 'ellipsis', android: 'more_horiz' }} size={sizes.icon} tintColor={busy ? colors.muted : colors.text} /></ActionMenu>
    </View>
  </ContentToolbarFrame>;
}
