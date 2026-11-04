import type { CardProps, StatsProps, TableProps } from '@companybot/core/widgets';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Button, Card, Stack, Text } from '@/components/ui';
import { useTheme } from '@/design';

export function Widget({ widget }: { widget: { type: string; props: unknown } }) {
  if (!widget.props || typeof widget.props !== 'object') return <Text tone="muted">Widget unavailable.</Text>;
  if (widget.type === 'table') return <Table data={widget.props as TableProps} />;
  if (widget.type === 'stats') return <Stats data={widget.props as StatsProps} />;
  if (widget.type === 'card') return <DetailCard data={widget.props as CardProps} />;
  return <Card><Text tone="muted">Update Companybot to view this widget.</Text></Card>;
}
function Table({ data }: { data: TableProps }) {
  const [expanded, setExpanded] = useState(false);
  const { spacing, colors } = useTheme();
  if (!Array.isArray(data.columns) || !Array.isArray(data.rows)) return <Text tone="muted">Table unavailable.</Text>;
  return <Card>{data.title && <Text variant="label">{data.title}</Text>}<ScrollView horizontal><View>
    <Stack horizontal gap="none">{data.columns.map((column, i) => <Text key={i} variant="label" style={{ width: 160, padding: spacing.sm }}>{column}</Text>)}</Stack>
    {(expanded ? data.rows : data.rows.slice(0, 10)).map((row, i) => <Stack key={i} horizontal gap="none" style={{ alignItems: 'flex-start', borderTopWidth: 1, borderColor: colors.border }}>{row.map((cell, c) => <Text selectable key={c} style={{ width: 160, padding: spacing.sm }}>{cell ?? '—'}</Text>)}</Stack>)}
  </View></ScrollView>{data.rows.length > 10 && <Button variant="ghost" label={expanded ? 'Show less' : `Show all ${data.rows.length} rows`} onPress={() => setExpanded(!expanded)} />}</Card>;
}
function Stats({ data }: { data: StatsProps }) {
  if (!Array.isArray(data.items)) return <Text tone="muted">Stats unavailable.</Text>;
  return <Card>{data.title && <Text variant="label">{data.title}</Text>}{data.items.map((item, i) => <Stack key={i} gap="xs"><Text tone="muted">{item.label}</Text><Text variant="heading">{item.value}</Text>{item.change && <Text variant="caption" tone={item.trend === 'up' ? 'success' : item.trend === 'down' ? 'danger' : 'muted'}>{item.change}</Text>}</Stack>)}</Card>;
}
function DetailCard({ data }: { data: CardProps }) {
  if (!Array.isArray(data.fields)) return <Text tone="muted">Card unavailable.</Text>;
  return <Card><Text variant="label">{data.title}</Text>{data.subtitle && <Text tone="muted">{data.subtitle}</Text>}{data.fields.map((field, i) => <Stack key={i} gap="xs"><Text variant="caption" tone="muted">{field.label}</Text><Text selectable>{field.value}</Text></Stack>)}</Card>;
}
