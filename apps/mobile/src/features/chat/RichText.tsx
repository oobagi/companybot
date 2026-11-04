import { Lexer, type Token, type Tokens } from 'marked';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { splitLinks } from '@companybot/core/link-preview';
import { Card, ConfirmSheet, Divider, ErrorState, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { useTask } from '@/lib/useTask';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { openContentLink } from './links';
import { plainInternalLinks } from './logic';

/** Parse Markdown once; render native text. HTML and remote images never execute/load. */
export function RichText({ value, plain = false }: { value: string; plain?: boolean }) {
  const tokens = useMemo(() => plain ? [] : Lexer.lex(value, { gfm: true }), [plain, value]);
  const task = useTask();
  const databases = useQuery(api.recordTypes.list, /#?\/records\//.test(value) ? {} : 'skip');
  const [external, setExternal] = useState<string>();
  const open = (url: string) => { if (!plain && !url.startsWith('#/') && !url.startsWith('/') && !url.startsWith('companybot://page/')) setExternal(url); else void task.run(() => openContentLink(url, databases)); };
  if (!value) return null;
  return <Stack gap="sm">{plain ? <Text selectable>{plainInternalLinks(value).map((segment, s) => typeof segment !== 'string' ? <Text key={s} tone="link" accessibilityRole="link" onPress={() => open(segment.href)}>{segment.label}</Text> : <Fragment key={s}>{splitLinks(segment).map((part, i) => typeof part === 'string' ? part : <Text key={i} tone="link" accessibilityRole="link" onPress={() => open(part.url)}>{part.url}</Text>)}</Fragment>)}</Text> : <Blocks tokens={tokens} open={open} />}{task.error && <ErrorState message={task.error} />}{external && <ConfirmSheet title="Open external link?" message={external} confirmLabel="Open link" busy={task.busy} error={task.error} onClose={() => setExternal(undefined)} onConfirm={() => void task.run(async () => { await openContentLink(external); setExternal(undefined); })} />}</Stack>;
}

function Inline({ tokens, open }: { tokens?: Token[]; open: (url: string) => void }) {
  return <>{tokens?.map((token, index): ReactNode => {
    if (token.type === 'strong') return <Text key={index} style={{ fontWeight: '700' }}><Inline tokens={(token as Tokens.Strong).tokens} open={open} /></Text>;
    if (token.type === 'em') return <Text key={index} style={{ fontStyle: 'italic' }}><Inline tokens={(token as Tokens.Em).tokens} open={open} /></Text>;
    if (token.type === 'del') return <Text key={index} style={{ textDecorationLine: 'line-through' }}><Inline tokens={(token as Tokens.Del).tokens} open={open} /></Text>;
    if (token.type === 'link') { const link = token as Tokens.Link; return <Text key={index} tone="link" accessibilityRole="link" onPress={() => open(link.href)}><Inline tokens={link.tokens} open={open} /></Text>; }
    if (token.type === 'image') { const image = token as Tokens.Image; return <Text key={index} tone="link" accessibilityRole="link" onPress={() => open(image.href)}>{image.text || 'Open image'}</Text>; }
    if (token.type === 'br') return '\n';
    if (token.type === 'codespan') return <Text key={index} style={{ fontFamily: 'monospace' }}>{(token as Tokens.Codespan).text}</Text>;
    const text = token as Tokens.Text;
    return text.tokens ? <Inline key={index} tokens={text.tokens} open={open} /> : <Fragment key={index}>{'text' in token ? String(token.text) : token.raw}</Fragment>;
  })}</>;
}

function Blocks({ tokens, open }: { tokens: Token[]; open: (url: string) => void }) {
  const { spacing, colors } = useTheme();
  return <>{tokens.map((token, index): ReactNode => {
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'hr': return <Divider key={index} />;
      case 'heading': return <Text key={index} variant="heading" accessibilityRole="header"><Inline tokens={(token as Tokens.Heading).tokens} open={open} /></Text>;
      case 'paragraph': case 'text': return <Text key={index} selectable><Inline tokens={(token as Tokens.Paragraph).tokens ?? [token]} open={open} /></Text>;
      case 'code': return <Card key={index}><Text variant="caption" tone="muted">{(token as Tokens.Code).lang ?? 'Code'}</Text><ScrollView horizontal><Text selectable style={{ fontFamily: 'monospace' }}>{(token as Tokens.Code).text}</Text></ScrollView></Card>;
      case 'blockquote': return <View key={index} style={{ paddingLeft: spacing.md, borderLeftWidth: 3, borderColor: colors.border }}><Blocks tokens={(token as Tokens.Blockquote).tokens} open={open} /></View>;
      case 'list': { const list = token as Tokens.List; return <Stack key={index} gap="sm">{list.items.map((item, i) => <Stack key={i} horizontal gap="sm" style={{ alignItems: 'flex-start' }}><Text>{item.task ? item.checked ? '☑' : '☐' : list.ordered ? `${Number(list.start) + i}.` : '•'}</Text><View style={{ flex: 1 }}><Blocks tokens={item.tokens} open={open} /></View></Stack>)}</Stack>; }
      case 'table': { const table = token as Tokens.Table; return <ScrollView horizontal key={index}><View><Stack horizontal gap="none">{table.header.map((cell, i) => <Text key={i} variant="label" style={{ width: 160, padding: spacing.sm }}><Inline tokens={cell.tokens} open={open} /></Text>)}</Stack>{table.rows.map((row, r) => <Stack key={r} horizontal gap="none" style={{ alignItems: 'flex-start', borderTopWidth: 1, borderColor: colors.border }}>{row.map((cell, c) => <Text key={c} selectable style={{ width: 160, padding: spacing.sm }}><Inline tokens={cell.tokens} open={open} /></Text>)}</Stack>)}</View></ScrollView>; }
      default: return <Text selectable key={index}>{'text' in token ? String(token.text) : token.raw}</Text>;
    }
  })}</>;
}
