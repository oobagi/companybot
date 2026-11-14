import { describe, expect, it } from 'vitest';
import { deviceViewKey, restoreDeviceView } from './deviceView';
import { activeView, type Database, type SavedView } from './model';

const database = { fields: [{ _id: 'name', key: 'name', kind: 'text', label: 'Name' }, { _id: 'value', key: 'value', kind: 'number', label: 'Value' }] } as Database;
const saved = (id: string, name: string, version = 7): SavedView => ({ _id: id, name, version, filters: [{ field: 'value', gt: 4 }], columns: ['name', 'value'], layout: 'table' }) as SavedView;
const raw = (config: unknown, baseVersion = 7) => JSON.stringify({ config, baseVersion });

describe('saved view navigation', () => {
  it('opens the first ordered saved view, without treating All as a special destination', () => {
    const all = saved('all-id', 'All');
    const board = saved('board-id', 'Pipeline');
    expect(activeView([board, all])).toBe(board);
    expect(activeView([board, all], all._id)).toBe(all);
    expect(activeView([board, { ...all, name: 'Renamed' }], all._id)?.name).toBe('Renamed');
  });
  it('falls back to the first remaining view after deletion, and no view for an empty database', () => {
    const first = saved('first', 'Current');
    expect(activeView([first], 'deleted')).toBe(first);
    expect(activeView([], 'deleted')).toBeUndefined();
  });
});

describe('device view overrides', () => {
  it('scopes an applied override to its workspace, database and saved view', () => {
    const key = deviceViewKey('a', 'db', 'first');
    expect(new Set([key, deviceViewKey('b', 'db', 'first'), deviceViewKey('a', 'other', 'first'), deviceViewKey('a', 'db', 'second')]).size).toBe(4);
  });
  it('uses current shared settings when there is no device override or it is corrupt', () => {
    const view = saved('first', 'All');
    for (const value of [null, 'not json', JSON.stringify(view), raw(view, -1), raw({ columns: ['name'] })]) {
      const restored = restoreDeviceView(value, database, 'USD', view);
      expect(restored.local).toBe(false);
      expect(restored.baseVersion).toBe(7);
      expect(restored.config.filters).toEqual(view.filters);
    }
    const newer = { ...view, version: 8, filters: [] };
    expect(restoreDeviceView(null, database, 'USD', newer)).toMatchObject({ baseVersion: 8, local: false, config: { filters: [] } });
  });
  it('keeps an applied draft and its original version through remote changes and reopening', () => {
    const remote = saved('first', 'Renamed remotely', 8);
    const config = { columns: ['name'], filters: [{ field: 'name', eq: 'Acme' }], layout: 'table' };
    const restored = restoreDeviceView(raw(config, 7), database, 'USD', remote);
    expect(restored).toMatchObject({ baseVersion: 7, local: true, config });
    expect(restored.baseVersion).not.toBe(remote.version);
    expect(restoreDeviceView(raw(restored.config, restored.baseVersion), database, 'USD', remote)).toEqual(restored);
  });
  it('drops removed fields from the query without rebasing the local draft version', () => {
    const config = { columns: ['removed', 'value'], filters: [{ field: 'removed', eq: 1 }, { field: 'value', gt: 4, lte: 9 }], sort: { field: 'removed', order: 'asc' }, layout: 'board', groupBy: 'removed' };
    const restored = restoreDeviceView(raw(config, 6), database, 'USD', saved('first', 'All'));
    expect(restored).toEqual({ baseVersion: 6, local: true, config: { columns: ['name', 'value'], filters: [{ field: 'value', gt: 4, lte: 9 }], sort: undefined, layout: 'board', groupBy: undefined } });
  });
});
