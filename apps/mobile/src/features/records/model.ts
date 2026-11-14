import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { formatDate, formatMoney, type Field, type FieldValue } from '@companybot/core/records';
import { api } from '@/lib/api';

export type Database = FunctionReturnType<typeof api.recordTypes.list>[number];
export type RecordRow = FunctionReturnType<typeof api.records.search>[number];
export type RecordDetail = NonNullable<FunctionReturnType<typeof api.records.get>>;
export type TypeField = Field & { _id: string; canEdit?: boolean; archived?: boolean; changing?: true };
export type ViewConfig = Pick<FunctionArgs<typeof api.databaseViews.save>, 'filters' | 'sort' | 'columns' | 'layout' | 'groupBy'>;
export type SavedView = FunctionReturnType<typeof api.databaseViews.list>[number];
export type Refs = Record<string, { name: string; archived?: true; locked?: true }>;

/** Used only when creating the database's first real saved view. */
export const defaultView = (database: Database): ViewConfig => ({ filters: [], columns: ['name', ...database.fields.filter(f => !f.archived && f.key !== 'name').slice(0, 4).map(f => f.key)], layout: 'table' });
/** Ordered saved views are the only destinations, including a view named All. */
export const activeView = (views: readonly SavedView[], selected?: string) => views.find(view => view._id === selected) ?? views[0];
export const sortable = (field: Field) => !field.multiple && field.kind !== 'link' && field.kind !== 'checkbox';
export const groupable = (field: Field) => field.kind === 'choice' && !field.multiple;
export function valueText(field: Field | undefined, value: FieldValue | null | undefined, refs: Refs = {}): string {
  if (value === undefined || value === null || (Array.isArray(value) && !value.length)) return 'Empty';
  if (Array.isArray(value)) return value.map(v => valueText(field && { ...field, multiple: false }, v, refs)).join(', ');
  if (typeof value === 'object' && 'minor' in value) return formatMoney(value);
  if (field?.kind === 'date') return formatDate(String(value));
  if (field?.kind === 'checkbox') return value ? 'Yes' : 'No';
  if (field?.kind === 'choice') { const option = field.options?.find(o => o.id === value); return option ? `${option.label}${option.retired ? ' (removed)' : ''}` : String(value); }
  if (field?.kind === 'link' || field?.kind === 'user') { const ref = refs[String(value)]; return ref?.locked ? 'Locked record' : ref ? `${ref.name}${ref.archived ? ' (archived)' : ''}` : 'Unavailable'; }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const ref = refs[String(value)];
  return ref?.locked ? 'Locked record' : ref ? `${ref.name}${ref.archived ? ' (archived)' : ''}` : String(value);
}
