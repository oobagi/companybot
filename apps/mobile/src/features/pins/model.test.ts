import { expect, it } from 'vitest';
import { pageEntry, recordBatches, recordEntry, routeTarget, savedKeys, splitPin } from './model';

it('uses desktop personal pin order, drops orphan order entries, and excludes pins from recents', () => {
  expect(savedKeys([
    { list: 'pins', ids: ['page:p', 'chat:c', 'rec:r', 'chat:c', 'bad-key'] },
    { list: 'pinsOrder', ids: ['deleted:x', 'rec:r', 'chat:c'] },
    { list: 'recent', ids: ['chat:c', 'db:client', 'page:other'] },
  ])).toEqual({ pins: ['rec:r', 'chat:c', 'page:p'], recent: ['db:client', 'page:other'] });
});

it('tracks detail navigation rather than directories or settings, retaining the owning chat in threads', () => {
  expect(routeTarget('/chat/c/thread/t')).toEqual({ kind: 'chat', id: 'c' });
  expect(routeTarget('/database/databaseId')).toEqual({ kind: 'db', id: 'databaseId' });
  expect(routeTarget('/record/r')).toEqual({ kind: 'rec', id: 'r' });
  expect(routeTarget('/pages/p')).toEqual({ kind: 'page', id: 'p' });
  for (const path of ['/pages', '/saved', '/settings/preferences', '/chat/%2fsettings', '/pages/%']) expect(routeTarget(path)).toBeUndefined();
  for (const key of ['chat:', 'chat:a/b', 'page:%2fsettings', 'rec:x?workspace=y', 'javascript:bad']) expect(splitPin(key)).toBeUndefined();
});

it('drops revoked, inherited-archived, and record-body page pins; uses the live title', () => {
  const page = { _id: 'p', title: 'Renamed', archived: false, recordId: null };
  expect(pageEntry('page:p', page)).toMatchObject({ title: 'Renamed', path: '/pages/p' });
  expect(pageEntry('page:p', null)).toBeUndefined();
  expect(pageEntry('page:p', undefined)).toBeUndefined();
  expect(pageEntry('page:p', { ...page, archived: true })).toBeUndefined();
  expect(pageEntry('page:p', { ...page, recordId: 'r' })).toBeUndefined();
});

it('never resolves record pins using retained old titles after the server removes access', () => {
  expect(recordEntry('rec:r', [{ _id: 'r', title: 'Current name' }])).toMatchObject({ title: 'Current name', path: '/record/r' });
  expect(recordEntry('rec:r', [])).toBeUndefined();
  expect(recordEntry('rec:r', undefined)).toBeUndefined();
});

it('does not silently truncate the fifty-first pinned record at the server title-query limit', () => {
  const ids = Array.from({ length: 123 }, (_, index) => `record${index}`);
  const batches = recordBatches(ids);
  expect(batches.map(batch => batch.length)).toEqual([50, 50, 23]);
  expect(batches.flat()).toEqual(ids);
  expect(recordBatches([])).toEqual([]);
});
