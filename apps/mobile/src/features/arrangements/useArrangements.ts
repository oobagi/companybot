import type { ArrangementList } from '@companybot/core/arrangements';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/convex';
import { orderRows } from './order';

/** Convex shares this workspace-scoped subscription across mounted directories. No local order state. */
export function useArrangements() {
  const data = useQuery(api.arrangements.get);
  return {
    loaded: data !== undefined,
    rows: data?.rows ?? [],
    writable: !!data?.writable,
    order: <T extends { _id: string }>(list: ArrangementList, items: readonly T[], entityId?: string) => data === undefined ? [] : orderRows(data?.rows ?? [], list, items, entityId),
  };
}
