import { expect, it } from 'vitest';
import { applyCommand } from '@companybot/core/arrangements';
import { moveCommands } from './move';
import { applyOrder } from './order';

const reorder = (saved: string[], shown: string[], sources: number[], destination: number, complete = true) => {
  const commands = moveCommands(saved, shown, sources, destination, complete);
  const next = commands.reduce((ids, command) => applyCommand(ids, command), saved);
  return { commands, saved: next, shown: applyOrder(next, shown.map(_id => ({ _id }))).map(item => item._id) };
};

it('converts native before-removal destinations in both directions and keeps adjacent drops unchanged', () => {
  const ids = ['a', 'b', 'c', 'd'];
  expect(reorder(ids, ids, [0], 3).shown).toEqual(['b', 'c', 'a', 'd']);
  expect(reorder(ids, ids, [3], 1).shown).toEqual(['a', 'd', 'b', 'c']);
  expect(reorder(ids, ids, [1], 2).commands).toEqual([]);
  expect(reorder(ids, ids, [1], 1).commands).toEqual([]);
});

it('fills unsaved predecessors so a drop stays in its displayed position', () => {
  expect(reorder([], ['a', 'b', 'c', 'd'], [0], 3).shown).toEqual(['b', 'c', 'a', 'd']);
  expect(reorder(['a'], ['a', 'b', 'c', 'd'], [3], 2).shown).toEqual(['a', 'b', 'd', 'c']);
});

it('moves multiple selected rows in original relative order', () => {
  expect(reorder([], ['a', 'b', 'c', 'd', 'e'], [3, 1, 1], 0).shown).toEqual(['b', 'd', 'a', 'c', 'e']);
  expect(reorder(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'e'], [0, 2], 5).shown).toEqual(['b', 'd', 'e', 'a', 'c']);
});

it('preserves hidden and concurrently inserted IDs instead of replacing the server list', () => {
  const commands = moveCommands(['a', 'hidden', 'b', 'c'], ['a', 'b', 'c'], [2], 0);
  expect(commands).toEqual([{ op: 'move', id: 'c', beforeId: 'a' }]);
  expect(commands.reduce((ids, command) => applyCommand(ids, command), ['a', 'new', 'hidden', 'b', 'c'])).toEqual(['c', 'a', 'new', 'hidden', 'b']);
});

it('allows anchored moves through loaded pages but rejects an ambiguous end until pagination finishes', () => {
  expect(reorder(['a', 'unloaded', 'b', 'c'], ['a', 'b', 'c'], [2], 1, false).saved).toEqual(['a', 'unloaded', 'c', 'b']);
  expect(() => moveCommands([], ['a', 'b', 'c'], [0], 3, false)).toThrow('Load all pages');
  expect(moveCommands([], ['a', 'b', 'c'], [2], 3, false)).toEqual([]);
});

it('rejects invalid native indices before constructing any mutation', () => {
  expect(() => moveCommands([], ['a'], [-1], 0)).toThrow('list changed');
  expect(() => moveCommands([], ['a'], [0], 2)).toThrow('list changed');
});
