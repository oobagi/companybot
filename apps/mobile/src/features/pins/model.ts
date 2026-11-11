import type { Arrangement } from '@companybot/core/arrangements';

export type PinKind = 'chat' | 'page' | 'db' | 'rec';
export type PinKey = `${PinKind}:${string}`;
export type PinEntry = { key: PinKey; title: string; description: string; path: `/chat/${string}` | `/pages/${string}` | `/database/${string}` | `/record/${string}`; unread?: boolean; mentioned?: boolean };

/** Personal arrangements may contain old or malformed keys. Never turn them into routes. */
export function splitPin(value: string): { kind: PinKind; id: string } | undefined {
  const match = /^(chat|page|db|rec):([^:/?#%\s]+)$/.exec(value);
  return match ? { kind: match[1] as PinKind, id: match[2] } : undefined;
}

export function savedKeys(rows: readonly Arrangement[]) {
  const ids = (list: Arrangement['list']) => [...new Set(rows.find(row => row.list === list)?.ids ?? [])].filter((id): id is PinKey => !!splitPin(id));
  const pins = ids('pins');
  const order = ids('rail');
  const pinned = new Set(pins);
  const orderedKeys = new Set(order);
  const ordered = [...order.filter(key => pinned.has(key)), ...pins.filter(key => !orderedKeys.has(key))];
  return { pins: ordered, recent: ids('recent').filter(key => !pinned.has(key)) };
}

/** Database pins deliberately use desktop's stable database key, not the mobile route's id. */
export function routeTarget(pathname: string): { kind: PinKind; id: string } | undefined {
  const [section, rawId] = pathname.split('/').filter(Boolean);
  if (!rawId) return undefined;
  let id: string;
  try { id = decodeURIComponent(rawId); } catch { return undefined; }
  if (!id || /[:/?#%\s]/.test(id)) return undefined;
  const kind = ({ chat: 'chat', pages: 'page', database: 'db', record: 'rec' } as const)[section as 'chat' | 'pages' | 'database' | 'record'];
  return kind ? { kind, id } : undefined;
}

export function pageEntry(key: PinKey, page: { _id: string; title: string; archived: boolean; recordId: string | null } | null | undefined): PinEntry | undefined {
  return page && !page.archived && !page.recordId ? { key, title: page.title || 'Untitled', description: 'Page', path: `/pages/${page._id}` } : undefined;
}

export function recordEntry(key: PinKey, records: readonly { _id: string; title: string }[] | undefined): PinEntry | undefined {
  const record = records?.find(row => row._id === splitPin(key)?.id);
  return record ? { key, title: record.title || 'Untitled', description: 'Record', path: `/record/${record._id}` } : undefined;
}

/** records.titles intentionally resolves at most 50 ids per request. */
export function recordBatches(ids: readonly string[]): string[][] {
  return Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) => ids.slice(index * 50, (index + 1) * 50));
}
