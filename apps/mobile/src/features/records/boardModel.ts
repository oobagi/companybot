import type { Field } from '@companybot/core/records';
import type { Database, ViewConfig } from './model';

export type BoardLane = { id: string; label: string; retired: boolean };
export function boardLanes(group: Field): BoardLane[] {
  return [{ id: '', label: `No ${group.label.toLowerCase()}`, retired: false }, ...(group.options ?? []).map(option => ({ id: option.id, label: option.retired ? `${option.label} (removed)` : option.label, retired: !!option.retired }))];
}

/** Grouping is separate from filters, preserving the server's full ten-filter budget. */
export const boardQuery = (typeId: Database['_id'], config: ViewConfig, group: Field, option: string) => ({
  typeId, filters: config.filters, sort: config.sort, group: { field: group.key, option: option || null },
});

/** Server canEdit already combines database Edit and the records.edit workspace switch. */
export function boardMove(canEdit: boolean, group: Field, from: string, destination: string): Record<string, string | null> | undefined {
  if (!canEdit || group.kind !== 'choice' || group.multiple || from === destination) return;
  if (destination && !group.options?.some(option => option.id === destination && !option.retired)) return;
  return { [group.key]: destination || null };
}
