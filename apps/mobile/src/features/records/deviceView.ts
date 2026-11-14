import { defaultView, groupable, sortable, type Database, type SavedView, type ViewConfig } from './model';
import { buildFilter, draftFilter, type Condition } from './filters';

export const deviceViewKey = (workspaceId: string, typeId: string, viewId: string) => `companybot.records.view.${workspaceId}.${typeId}.${viewId}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export type DeviceViewDraft = { config: ViewConfig; baseVersion: number; local: boolean };

/** Applied device overrides retain the version they started from, even after a remote edit. */
export function restoreDeviceView(raw: string | null, database: Database, currency: string, view: SavedView): DeviceViewDraft {
  const shared = { config: normalizeViewConfig(view, database, currency), baseVersion: view.version, local: false };
  if (!raw) return shared;
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || !object(value.config) || !Array.isArray(value.config.columns) || !Array.isArray(value.config.filters) || typeof value.baseVersion !== 'number' || !Number.isInteger(value.baseVersion) || value.baseVersion < 1) return shared;
    return { config: normalizeViewConfig(value.config, database, currency), baseVersion: value.baseVersion, local: true };
  } catch { return shared; }
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
