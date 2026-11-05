import { defaultView, groupable, sortable, type Database, type ViewConfig } from './model';
import { buildFilter, draftFilter, type Condition } from './filters';

export const deviceViewKey = (workspaceId: string, typeId: string) => `companybot.records.view.${workspaceId}.${typeId}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Device preferences may outlive fields, options, or schema versions. Never send stale keys to list queries. */
export function restoreDeviceView(raw: string | null, database: Database, currency: string): ViewConfig {
  if (!raw) return defaultView(database);
  try { return normalizeViewConfig(JSON.parse(raw), database, currency); }
  catch { return defaultView(database); }
}

/** Shared views also outlive field changes. Normalize on render without rebasing the saved version. */
export function normalizeViewConfig(value: unknown, database: Database, currency: string): ViewConfig {
  const fallback = defaultView(database);
  if (!object(value)) return fallback;
  const fields = database.fields.filter(f => !f.archived);
  const columns = Array.isArray(value.columns) ? [...new Set(['name', ...value.columns.filter((key): key is string => typeof key === 'string' && fields.some(f => f.key === key))])] : fallback.columns;
  const filters: Condition[] = [];
  if (Array.isArray(value.filters)) for (const candidate of value.filters.slice(0, 10)) {
    if (!object(candidate) || typeof candidate.field !== 'string') continue;
    const field = fields.find(f => f.key === candidate.field);
    if (!field) continue;
    try { filters.push(buildFilter(field, draftFilter(field.key, candidate as Condition), currency)); } catch { /* A removed choice or corrupt value should not break opening a database. */ }
  }
  const sortValue = value.sort;
  const sort = object(sortValue) && typeof sortValue.field === 'string' && (sortValue.order === 'asc' || sortValue.order === 'desc') && (['createdAt', 'updatedAt'].includes(sortValue.field) || fields.some(f => f.key === sortValue.field && sortable(f))) ? { field: sortValue.field, order: sortValue.order } as ViewConfig['sort'] : undefined;
  const groupBy = typeof value.groupBy === 'string' && fields.some(f => f.key === value.groupBy && groupable(f)) ? value.groupBy : undefined;
  return { columns, filters, sort, groupBy, layout: value.layout === 'board' ? 'board' : 'table' };
}
