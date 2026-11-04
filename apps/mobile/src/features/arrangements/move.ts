import type { ArrangementCommand } from '@companybot/core/arrangements';

/** SwiftUI destinations count positions before removal, including data.length. */
export function moveCommands(saved: readonly string[], shown: readonly string[], sources: readonly number[], destination: number, complete = true): ArrangementCommand[] {
  const indices = [...new Set(sources)].sort((a, b) => a - b);
  if (!indices.length) return [];
  if (!Number.isInteger(destination) || destination < 0 || destination > shown.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= shown.length)) throw new Error('The list changed. Try moving the item again.');
  const moving = new Set(indices);
  const moved = indices.map(index => shown[index]!);
  const rest = shown.filter((_, index) => !moving.has(index));
  const target = destination - indices.filter(index => index < destination).length;
  const next = [...rest.slice(0, target), ...moved, ...rest.slice(target)];
  if (next.every((id, index) => id === shown[index])) return [];
  const beforeId = rest[target] ?? null;
  if (beforeId === null && !complete) throw new Error('Load all pages before moving an item to the end. You can move it before any loaded page now.');
  const known = new Set(saved);
  const fill = rest.slice(0, target).filter(id => !known.has(id));
  return moved.map(id => ({ op: 'move', id, beforeId, ...(fill.length ? { fill } : {}) }));
}
