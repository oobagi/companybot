import { expect, it } from 'vitest';
import type { Field } from '@companybot/core/records';
import { boardLanes, boardMove, boardQuery } from './boardModel';
import type { Database, ViewConfig } from './model';

const group: Field = { key: 'status', label: 'Status', kind: 'choice', options: [{ id: 'new', label: 'New' }, { id: 'won', label: 'Won' }, { id: 'old', label: 'Old', retired: true }] };

it('keeps every active column available even when the ungrouped column is empty', () => {
  expect(boardLanes(group)).toEqual([
    { id: '', label: 'No status', retired: false },
    { id: 'new', label: 'New', retired: false },
    { id: 'won', label: 'Won', retired: false },
    { id: 'old', label: 'Old (removed)', retired: true },
  ]);
});

it('moves only the grouping field and clears it with null for the ungrouped column', () => {
  expect(boardMove(true, group, 'new', 'won')).toEqual({ status: 'won' });
  expect(boardMove(true, group, 'new', '')).toEqual({ status: null });
  expect(boardMove(true, group, 'old', 'new')).toEqual({ status: 'new' });
});

it('keeps filters and sort on every lane while grouping outside the filter budget', () => {
  const config: ViewConfig = { columns: ['name'], filters: Array.from({ length: 10 }, (_, i) => ({ field: `field${i}`, eq: 'value' })), sort: { field: 'updatedAt', order: 'desc' } };
  const typeId = 'database' as Database['_id'];
  expect(boardQuery(typeId, config, group, '')).toEqual({ typeId, filters: config.filters, sort: config.sort, group: { field: 'status', option: null } });
  expect(boardQuery(typeId, config, group, 'won')).toEqual({ typeId, filters: config.filters, sort: config.sort, group: { field: 'status', option: 'won' } });
  expect(config.filters).toHaveLength(10);
});

it('refuses read-only, retired, stale or unchanged destinations', () => {
  expect(boardMove(false, group, 'new', 'won')).toBeUndefined();
  expect(boardMove(true, group, 'new', 'old')).toBeUndefined();
  expect(boardMove(true, group, 'new', 'deleted')).toBeUndefined();
  expect(boardMove(true, group, 'new', 'new')).toBeUndefined();
  expect(boardMove(true, { ...group, multiple: true }, 'new', 'won')).toBeUndefined();
  expect(boardMove(true, { ...group, kind: 'text' }, 'new', 'won')).toBeUndefined();
});
