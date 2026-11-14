import type { ReactNode } from 'react';
import { router } from 'expo-router';
import { ListRow } from '@/components/ui';
import { useTheme } from '@/design';
import { valueText, type Database, type RecordRow, type ViewConfig } from './model';

export function RecordCard({ row, database, config, refs, action, presentation = 'card' }: { row: RecordRow; database: Database; config: ViewConfig; refs: RecordRow['refs']; action?: ReactNode; presentation?: 'card' | 'row' }) {
  const { colors, radii } = useTheme();
  const fields = config.columns.filter(key => key !== 'name').map(key => database.fields.find(f => f.key === key && !f.archived)).filter(f => f !== undefined);
  const description = fields.filter(field => row.values[field.key] !== undefined)
    .map(field => `${field.label}: ${valueText(field, row.values[field.key], refs)}`).join('\n');
  return <ListRow title={row.title || 'Untitled'} description={description || undefined} disclosure={presentation === 'row'} trailing={action}
    onPress={() => router.push(`/record/${row._id}`)} style={presentation === 'card' ? { backgroundColor: colors.background, borderRadius: radii.md } : undefined} />;
}

