import { DOCX, PPTX, XLSX, isImageType } from '@companybot/core/files';
import { type Sheet, parseCsv, readDocx, readPptx, readXlsx } from '@companybot/core/office-text';
import { fetch as expoFetch } from 'expo/fetch';
import { useEffect, useState, type ReactNode } from 'react';
import { Image, ScrollView, View, useWindowDimensions } from 'react-native';
import { Button, Card, ChoicePicker, EmptyState, ErrorState, Loading, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';
import { RichText } from '@/features/chat/RichText';

// A Drive file shown natively, like desktop's viewer: pictures as they are; Word, Excel, CSV and
// PowerPoint through core's office-text readers (the ones agents read with); Markdown and text as text.
// PDFs and anything else open in the browser from the file's menu.

/** Past this many bytes a file isn't fetched for showing; Open in browser still works. */
const RENDER_MAX = 25 * 1024 * 1024;
/** A phone renders every cell as a view, so it shows fewer rows than desktop. */
const ROWS_MAX = 300;
const COLS_MAX = 30;
const TEXT_MAX = 200_000;

export function canShowInline(type: string) {
  return isImageType(type) || [DOCX, XLSX, PPTX, 'text/csv', 'application/json'].includes(type) || type.startsWith('text/');
}

export function FileViewer({ url, type, name, width, height, onOpen }: { url: string; type: string; name: string; width: number | null; height: number | null; onOpen: () => void }) {
  const window = useWindowDimensions();
  const { colors, radii } = useTheme();
  if (isImageType(type)) return <Image source={{ uri: url }} accessibilityLabel={name} resizeMode="contain" style={{ width: '100%', aspectRatio: width && height ? width / height : 1, maxHeight: window.height * 0.75, backgroundColor: colors.surface, borderRadius: radii.md }} />;
  if (type === DOCX) return <Fetched url={url} render={bytes => <TextBody text={readDocx(bytes)} />} />;
  if (type === XLSX) return <Fetched url={url} render={bytes => <SheetsView sheets={readXlsx(bytes)} />} />;
  if (type === PPTX) return <Fetched url={url} render={bytes => <SlidesView slides={readPptx(bytes)} />} />;
  if (type === 'text/csv') return <Fetched url={url} render={bytes => <SheetsView sheets={[{ name, rows: parseCsv(decode(bytes)) }]} />} />;
  if (type === 'text/markdown') return <Fetched url={url} render={bytes => <RichText value={decode(bytes)} />} />;
  if (type.startsWith('text/') || type === 'application/json') return <Fetched url={url} render={bytes => <TextBody text={decode(bytes)} mono />} />;
  return <Stack gap="md">
    <EmptyState title={type === 'application/pdf' ? 'View this PDF in your browser' : 'This file can’t be shown here'} description="Open it in your browser to view or download it." />
    <Button label="Open in browser" variant="secondary" onPress={onOpen} />
  </Stack>;
}

const decode = (bytes: Uint8Array) => {
  const text = new TextDecoder().decode(bytes);
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n…` : text;
};

function Fetched({ url, render }: { url: string; render: (bytes: Uint8Array) => ReactNode }) {
  const [state, setState] = useState<{ bytes?: Uint8Array; error?: string }>({});
  useEffect(() => {
    let live = true;
    expoFetch(url)
      .then(async response => {
        if (!response.ok) throw new Error(`Couldn’t load the file (${response.status}).`);
        if (Number(response.headers.get('content-length') ?? 0) > RENDER_MAX) throw new Error('It’s too big to show here. Open it in your browser instead.');
        return new Uint8Array(await response.arrayBuffer());
      })
      .then(bytes => { if (live) setState({ bytes }); }, (e: unknown) => { if (live) setState({ error: e instanceof Error ? e.message : 'Couldn’t load the file. Open it in your browser instead.' }); });
    return () => { live = false; };
  }, [url]);
  if (state.error) return <ErrorState message={state.error} />;
  if (!state.bytes) return <Loading label="Loading file…" />;
  return <>{render(state.bytes)}</>;
}

function TextBody({ text, mono }: { text: string | undefined; mono?: boolean }) {
  if (text === undefined) return <ErrorState message="It’s too big to show here. Open it in your browser instead." />;
  if (!text.trim()) return <EmptyState title="No text" description="This file has no text to show." />;
  return <Text selectable style={mono ? { fontFamily: process.env.EXPO_OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13 } : undefined}>{text}</Text>;
}

function SheetsView({ sheets }: { sheets: Sheet[] | undefined }) {
  const { colors, spacing } = useTheme();
  const [index, setIndex] = useState(0);
  if (!sheets) return <ErrorState message="It’s too big to show here. Open it in your browser instead." />;
  if (!sheets.length) return <EmptyState title="No sheets" description="The workbook has no sheets." />;
  const open = Math.min(index, sheets.length - 1);
  const sheet = sheets[open]!;
  const rows = sheet.rows.slice(0, ROWS_MAX);
  const cols = Math.min(COLS_MAX, Math.max(1, ...rows.map(r => r.length)));
  const cut = sheet.rows.length > ROWS_MAX || sheet.rows.some(r => r.length > COLS_MAX);
  return <Stack gap="md">
    {sheets.length > 1 && <ChoicePicker label="Sheet" presentation="compact" value={String(open)} options={sheets.map((s, i) => ({ value: String(i), label: s.name || `Sheet ${i + 1}` }))} onChange={value => setIndex(Number(value))} />}
    {rows.length ? <ScrollView horizontal>
      <View style={{ borderTopWidth: 1, borderLeftWidth: 1, borderColor: colors.border }}>{rows.map((row, r) => <View key={r} style={{ flexDirection: 'row', backgroundColor: r === 0 ? colors.surface : undefined }}>
        {Array.from({ length: cols }, (_, c) => <View key={c} style={{ width: 140, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.border }}>
          <Text variant="supporting" numberOfLines={3} selectable>{row[c] ?? ''}</Text>
        </View>)}
      </View>)}</View>
    </ScrollView> : <EmptyState title="Empty sheet" description="This sheet has no cells." />}
    {cut && <Text variant="supporting" tone="muted">Showing the first {ROWS_MAX} rows and {COLS_MAX} columns. Open it in your browser for the rest.</Text>}
  </Stack>;
}

function SlidesView({ slides }: { slides: string[][] | undefined }) {
  if (!slides) return <ErrorState message="It’s too big to show here. Open it in your browser instead." />;
  if (!slides.length) return <EmptyState title="No slides" description="The deck has no slides." />;
  return <Stack gap="md">{slides.map((paragraphs, i) => <Card key={i}><Stack gap="sm">
    <Text variant="supporting" tone="muted">Slide {i + 1}</Text>
    {paragraphs.length ? paragraphs.map((p, j) => <Text key={j} variant={j === 0 ? 'heading' : undefined} selectable>{p}</Text>) : <Text tone="muted">No text on this slide.</Text>}
  </Stack></Card>)}</Stack>;
}
