import { describe, expect, it } from 'vitest';
import { formatDate, formatMoney, type Field } from '@companybot/core/records';
import { buildFilter, draftFilter, filterDescription, replaceFilter, viewIsStale } from './filters';
import { normalizeViewConfig } from './deviceView';
import type { Database } from './model';

const field = (kind: Field['kind']): Field => ({ key: 'value', label: 'Value', kind });
describe('mobile record filters', () => {
  it('round-trips two range bounds without losing strictness or combining two backend conditions', () => {
    const condition = { field: 'value', gt: 4, lte: 100 };
    expect(buildFilter(field('number'), draftFilter('value', condition), 'USD')).toEqual(condition);
  });
  it('preserves stable multi-choice ids including retired values used in saved filters', () => {
    const choice = { ...field('choice'), multiple: true, options: [{ id: 'a', label: 'Active' }, { id: 'b', label: 'Previous', retired: true }] };
    const condition = { field: 'value', in: ['a', 'b'] };
    expect(buildFilter(choice, draftFilter('value', condition), 'USD')).toEqual(condition);
  });
  it('keeps currency values in whole input units rather than normalizing minor units twice', () => {
    const condition = { field: 'value', gte: 'JPY 150', lt: 'JPY 300' };
    expect(buildFilter(field('currency'), draftFilter('value', condition), 'USD')).toEqual(condition);
    expect(buildFilter(field('currency'), draftFilter('value', { field: 'value', eq: { minor: 1250, currency: 'EUR' } }), 'USD')).toEqual({ field: 'value', eq: 'EUR 12.50' });
  });
  it('uses the empty index path for unchecked fields', () => {
    expect(buildFilter(field('checkbox'), { ...draftFilter('value'), value: 'false' }, 'USD')).toEqual({ field: 'value', empty: true });
  });
  it('refuses mixed-currency bounds before a list query can fail', () => {
    expect(() => buildFilter(field('currency'), { ...draftFilter('value'), op: 'range', lower: 'EUR 1', upper: 'USD 9' }, 'USD')).toThrow('one currency');
  });
  it('rejects invalid dates and oversized any-of selections before querying', () => {
    expect(() => buildFilter(field('date'), { ...draftFilter('value'), value: '2026-99-90' }, 'USD')).toThrow('valid');
    expect(() => buildFilter(field('user'), { ...draftFilter('value'), op: 'in', values: Array.from({ length: 51 }, (_, i) => String(i)) }, 'USD')).toThrow('50');
  });
  it('allows editing the tenth filter while refusing an eleventh', () => {
    const filters = Array.from({ length: 10 }, () => ({ field: 'value', eq: 1 }));
    expect(() => replaceFilter(filters, { field: 'value', eq: 2 })).toThrow('10');
    expect(replaceFilter(filters, { field: 'value', eq: 2 }, 9)[9]).toEqual({ field: 'value', eq: 2 });
    expect(filters[9].eq).toBe(1);
  });
  it('keeps stale or deleted shared views from silently overwriting remote edits', () => {
    expect(viewIsStale(3, 3)).toBe(false);
    expect(viewIsStale(3, 4)).toBe(true);
    expect(viewIsStale(3, undefined)).toBe(true);
  });
});

describe('filter descriptions', () => {
  it('shows text and option labels without query syntax or stored choice ids', () => {
    expect(filterDescription(field('text'), { field: 'value', eq: 'Preview' })).toBe('Is Preview');
    const choice = { ...field('choice'), options: [{ id: 'a', label: 'Open' }, { id: 'b', label: 'Previous', retired: true }] };
    expect(filterDescription(choice, { field: 'value', eq: 'a' })).toBe('Is Open');
    expect(filterDescription(choice, { field: 'value', in: ['a', 'b'] })).toBe('Is any of Open, Previous (removed)');
    expect(filterDescription(choice, { field: 'value', eq: 'b' })).toBe('Is Previous (removed)');
    expect(filterDescription(choice, { field: 'value', eq: 'missing-private-id' })).toBe('Is Unavailable option');
  });
  it('distinguishes checked values from empty non-checkbox values', () => {
    expect(filterDescription(field('checkbox'), { field: 'value', empty: true })).toBe('Is unchecked');
    expect(filterDescription(field('checkbox'), { field: 'value', empty: false })).toBe('Is checked');
    expect(filterDescription(field('checkbox'), { field: 'value', eq: true })).toBe('Is checked');
    expect(filterDescription(field('text'), { field: 'value', empty: true })).toBe('Is empty');
    expect(filterDescription(field('text'), { field: 'value', empty: false })).toBe('Is not empty');
  });
  it('keeps strict and inclusive numeric bounds distinct, including zero', () => {
    expect(filterDescription(field('number'), { field: 'value', gt: 0, lte: 100 })).toBe('More than 0 and at most 100');
    expect(filterDescription(field('number'), { field: 'value', gte: 0, lt: 100 })).toBe('At least 0 and less than 100');
  });
  it('keeps calendar date strictness and formats dates through the shared formatter', () => {
    const lower = '2026-11-01', upper = '2026-11-30';
    expect(filterDescription(field('date'), { field: 'value', gt: lower, lte: upper })).toBe(`After ${formatDate(lower)} and on or before ${formatDate(upper)}`);
    expect(filterDescription(field('date'), { field: 'value', gte: lower, lt: upper })).toBe(`On or after ${formatDate(lower)} and before ${formatDate(upper)}`);
  });
  it('formats saved and unsaved currency amounts without confusing minor and input units', () => {
    const money = { minor: 1250, currency: 'EUR' };
    expect(filterDescription(field('currency'), { field: 'value', eq: money })).toBe(`Is ${formatMoney(money)}`);
    expect(filterDescription(field('currency'), { field: 'value', eq: 'EUR 12.50' })).toBe(`Is ${formatMoney(money)}`);
    expect(filterDescription(field('currency'), { field: 'value', gte: '12.50' }, 'EUR')).toBe(`At least ${formatMoney(money)}`);
  });
  it('summarizes reference selections without exposing ids', () => {
    expect(filterDescription(field('user'), { field: 'value', eq: 'private-user-id' })).toBe('Is 1 person');
    expect(filterDescription(field('user'), { field: 'value', in: ['private-a', 'private-b'] })).toBe('Is any of 2 people');
    expect(filterDescription(field('link'), { field: 'value', eq: 'private-record-id' })).toBe('Is 1 record');
    expect(filterDescription(field('link'), { field: 'value', in: ['private-a', 'private-b'] })).toBe('Is any of 2 records');
    expect(filterDescription(undefined, { field: 'private-field-key', eq: 'private-value' })).toBe('Field unavailable');
  });
});

describe('device database views', () => {
  const database = { fields: [{ _id: 'name', key: 'name', kind: 'text', label: 'Name' }, { _id: 'value', key: 'value', kind: 'number', label: 'Value' }] } as Database;
  it('keeps a selected shared view queryable after a live field archival without changing its save baseline', () => {
    const saved = { version: 7, columns: ['name', 'value'], filters: [{ field: 'value', gt: 4 }, { field: 'name', eq: 'Acme' }], sort: { field: 'value', order: 'asc' }, layout: 'table' };
    const original = structuredClone(saved);
    expect(normalizeViewConfig(saved, database, 'USD').filters).toEqual(saved.filters);
    const archived = { ...database, fields: database.fields.map(f => f.key === 'value' ? { ...f, archived: true } : f) };
    expect(normalizeViewConfig(saved, archived, 'USD')).toEqual({ columns: ['name'], filters: [{ field: 'name', eq: 'Acme' }], sort: undefined, groupBy: undefined, layout: 'table' });
    expect(saved).toEqual(original);
    expect(viewIsStale(saved.version, 8)).toBe(true);
  });
});
