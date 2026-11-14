import { useEffect, useMemo, useRef } from 'react';
import { usePathname } from 'expo-router';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { routeTarget, type PinKey } from './model';
import { usePinEntries } from './usePinEntries';

/** One observer inside WorkspaceProvider, never one per background stack screen. */
export function RecentNavigation() {
  const pathname = usePathname();
  const target = routeTarget(pathname);
  const databases = useQuery(api.recordTypes.list, target?.kind === 'db' ? {} : 'skip');
  const page = useQuery(api.pages.get, target?.kind === 'page' ? { pageId: target.id } : 'skip');
  const database = target?.kind === 'db' ? databases?.find(row => row._id === target.id) : undefined;
  const key: PinKey | undefined = !target ? undefined : target.kind === 'db' ? database ? `db:${database.key}` : undefined
    : target.kind === 'page' ? page && !page.archived ? page.recordId ? `rec:${page.recordId}` : `page:${page._id}` : undefined
    : `${target.kind}:${target.id}`;
  const keys = useMemo(() => key ? [key] : [], [key]);
  const { entries } = usePinEntries(keys);
  const visibleKey = entries[0]?.key;
  const visit = useMutation(api.arrangements.change);
  const last = useRef<PinKey | undefined>(undefined);
  useEffect(() => {
    if (!visibleKey) { last.current = undefined; return; }
    if (last.current === visibleKey) return;
    last.current = visibleKey;
    // Best-effort history must not block reading. Explicit pin changes surface their errors.
    void visit({ list: 'recent', command: { op: 'visit', id: visibleKey } }).catch(() => {});
  }, [visibleKey, visit]);
  return null;
}
