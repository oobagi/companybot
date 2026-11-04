import type { Arrangement, ArrangementList } from '@companybot/core/arrangements';

/** Matches desktop applyOrder: saved ids first, new items afterward in their original order. */
export function applyOrder<T extends { _id: string }>(ids: readonly string[], items: readonly T[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, rank: rank.get(item._id) ?? ids.length + index }))
    .sort((left, right) => left.rank - right.rank).map(entry => entry.item);
}

/** Entity scope matters: page siblings and saved views each have their own list. */
export function orderRows<T extends { _id: string }>(rows: readonly Arrangement[], list: ArrangementList, items: readonly T[], entityId?: string): T[] {
  return applyOrder(rows.find(row => row.list === list && row.entityId === entityId)?.ids ?? [], items);
}
