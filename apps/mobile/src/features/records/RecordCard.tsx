import type { ReactNode } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Card, ListRow, Text } from '@/components/ui';
import { valueText, type Database, type RecordRow, type ViewConfig } from './model';

export function RecordCard({ row, database, config, refs, action }: { row: RecordRow; database: Database; config: ViewConfig; refs: RecordRow['refs']; action?: ReactNode }) {
  const fields = config.columns.filter(key => key !== 'name').map(key => database.fields.find(f => f.key === key && !f.archived)).filter(f => f !== undefined);
  return <Card><View style={{ flexDirection: 'row', alignItems: 'center' }}><View style={{ flex: 1 }}><ListRow title={row.title} onPress={() => router.push(`/record/${row._id}`)} /></View>{action}</View>
    {fields.filter(field => row.values[field.key] !== undefined).map(field => <View key={field.key}><Text variant="caption" tone="muted">{field.label}</Text><Text>{valueText(field, row.values[field.key], refs)}</Text></View>)}
  </Card>;
}

