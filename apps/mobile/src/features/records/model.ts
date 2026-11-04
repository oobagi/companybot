import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { formatDate, formatMoney, type Field, type FieldValue } from '@companybot/core/records';
import { api } from '@/lib/api';

export type Database = FunctionReturnType<typeof api.recordTypes.list>[number];
export type RecordRow = FunctionReturnType<typeof api.records.search>[number];
export type RecordDetail = NonNullable<FunctionReturnType<typeof api.records.get>>;
export type TypeField = Field & { _id: string; canEdit?: boolean; archived?: boolean };
export type ViewConfig = Pick<FunctionArgs<typeof api.databaseViews.save>, 'filters' | 'sort' | 'columns' | 'layout' | 'groupBy'>;
export type SavedView = FunctionReturnType<typeof api.databaseViews.list>[number];
export type Refs = Record<string, { name: string; archived?: true }>;

export const defaultView = (database: Database): ViewConfig => ({ filters: [], columns: database.fields.filter(f => !f.archived).slice(0, 5).map(f => f.key), layout: 'table' });
export const sortable = (field: Field) => !field.multiple && field.kind !== 'link' && field.kind !== 'checkbox';
export const groupable = (field: Field) => field.kind === 'choice' && !field.multiple;
export function valueText(field: Field | undefined, value: FieldValue | null | undefined, refs: Refs = {}): string {
  if (value === undefined || value === null) return 'Empty';
  if (Array.isArray(value)) return value.map(v => valueText(field && { ...field, multiple: false }, v, refs)).join(', ');
  if (typeof value === 'object' && 'minor' in value) return formatMoney(value);
  if (field?.kind === 'date') return formatDate(String(value));
  if (field?.kind === 'checkbox') return value ? 'Yes' : 'No';
  if (field?.kind === 'choice') { const option = field.options?.find(o => o.id === value); return option ? `${option.label}${option.retired ? ' (removed)' : ''}` : String(value); }
  if (field?.kind === 'link' || field?.kind === 'user') { const ref = refs[String(value)]; return ref ? `${ref.name}${ref.archived ? ' (archived)' : ''}` : 'Unavailable'; }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const ref = refs[String(value)];
  return ref ? `${ref.name}${ref.archived ? ' (archived)' : ''}` : String(value);
}
