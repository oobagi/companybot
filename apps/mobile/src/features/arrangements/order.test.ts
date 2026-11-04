import { expect, it } from 'vitest';
import { applyOrder, orderRows } from './order';

const items = ['a', 'b', 'c', 'd'].map(_id => ({ _id }));
it('uses the authoritative remote order while keeping new rows stable at the end', () => {
  expect(applyOrder(['c', 'a'], items).map(row => row._id)).toEqual(['c', 'a', 'b', 'd']);
  expect(applyOrder(['a', 'c'], items).map(row => row._id)).toEqual(['a', 'c', 'b', 'd']);
  expect(items.map(row => row._id)).toEqual(['a', 'b', 'c', 'd']);
});
it('ignores removed/hidden ids and places newly loaded page rows at their saved positions', () => {
  expect(applyOrder(['hidden', 'c', 'a'], items.slice(0, 2)).map(row => row._id)).toEqual(['a', 'b']);
  expect(applyOrder(['hidden', 'c', 'a'], items.slice(0, 3)).map(row => row._id)).toEqual(['c', 'a', 'b']);
});
it('keeps root pages, child pages and database view lists separate', () => {
  const rows = [{ list: 'pages' as const, ids: ['b', 'a'] }, { list: 'pages' as const, entityId: 'parent', ids: ['c', 'a'] }, { list: 'views' as const, entityId: 'parent', ids: ['d'] }];
  expect(orderRows(rows, 'pages', items).map(row => row._id)).toEqual(['b', 'a', 'c', 'd']);
  expect(orderRows(rows, 'pages', items, 'parent').map(row => row._id)).toEqual(['c', 'a', 'b', 'd']);
  expect(orderRows(rows, 'views', items, 'parent').map(row => row._id)).toEqual(['d', 'a', 'b', 'c']);
  expect(orderRows(rows, 'pages', items, 'other')).toEqual(items);
});
