import { useMemo } from 'react';
import { useQueries } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@/lib/api';
import { useQuery, useWorkspace } from '@/lib/convex';
import { chatTitle } from '@/features/chat/types';
import { fileEntry, pageEntry, recordEntry, recordBatches as batchRecords, splitPin, type PinEntry, type PinKey } from './model';

type Page = FunctionReturnType<typeof api.pages.get>;
type Records = FunctionReturnType<typeof api.records.titles>;

/** Resolve only requested saved items. A page beyond pages.list's cap still works. */
export function usePinEntries(keys: readonly PinKey[]) {
  const workspace = useWorkspace();
  const chats = useQuery(api.chats.list, keys.some(key => key.startsWith('chat:')) ? {} : 'skip');
  const databases = useQuery(api.recordTypes.list, keys.some(key => key.startsWith('db:')) ? {} : 'skip');
  const recordIds = keys.flatMap(key => { const pin = splitPin(key); return pin?.kind === 'rec' ? [pin.id] : []; });
  const recordKey = recordIds.join(',');
  // driveFiles.titles takes at most 100 ids.
  const fileIds = keys.flatMap(key => { const pin = splitPin(key); return pin?.kind === 'file' ? [pin.id] : []; }).slice(0, 100);
  const files = useQuery(api.driveFiles.titles, fileIds.length ? { ids: fileIds } : 'skip');
  // useQueries has no workspace adapter: each request explicitly carries the selected workspace.
  const pageQueries = useMemo(() => workspace ? Object.fromEntries(keys.flatMap(key => {
    const pin = splitPin(key);
    return pin?.kind === 'page' ? [[key, { query: api.pages.get, args: { workspaceId: workspace.id, pageId: pin.id } }]] : [];
  })) : {}, [keys, workspace]);
  const recordQueries = useMemo(() => {
    const ids = recordKey ? recordKey.split(',') : [];
    return workspace ? Object.fromEntries(batchRecords(ids).map((recordIds, index) => [index, { query: api.records.titles, args: { workspaceId: workspace.id, recordIds } }])) : {};
  }, [recordKey, workspace]);
  const pages = useQueries(pageQueries) as Record<string, Page | undefined | Error>;
  const recordBatches = useQueries(recordQueries) as Record<string, Records | undefined | Error>;
  const records = Object.values(recordBatches).flatMap(batch => Array.isArray(batch) ? batch : []);
  const errors = [...Object.values(pages), ...Object.values(recordBatches)].filter((value): value is Error => value instanceof Error);
  const loading = keys.some(key => key.startsWith('chat:')) && chats === undefined
    || keys.some(key => key.startsWith('db:')) && databases === undefined
    || fileIds.length > 0 && files === undefined
    || Object.values(pages).some(page => page === undefined)
    || Object.values(recordBatches).some(batch => batch === undefined);
  const entries = keys.flatMap((key): PinEntry[] => {
    const pin = splitPin(key);
    if (!pin) return [];
    if (pin.kind === 'page') { const page = pages[key]; const entry = page instanceof Error ? undefined : pageEntry(key, page); return entry ? [entry] : []; }
    if (pin.kind === 'file') { const entry = fileEntry(key, files); return entry ? [entry] : []; }
    if (pin.kind === 'rec') { const entry = recordEntry(key, records); return entry ? [entry] : []; }
    if (pin.kind === 'db') {
      const database = databases?.find(row => row.key === pin.id);
      return database ? [{ key, title: database.plural, description: 'Database', path: `/database/${database._id}` }] : [];
    }
    const channel = chats?.channels.find(row => row._id === pin.id);
    const agent = chats?.agents.find(row => row.dmId === pin.id);
    const dm = chats?.dms.find(row => row._id === pin.id);
    const chat = channel ?? dm;
    if (chat) return [{ key, title: chatTitle(chat), description: channel ? 'Channel' : dm?.parentId ? 'Side chat' : 'Conversation', path: `/chat/${pin.id}`, unread: chat.unread, mentioned: chat.mentioned }];
    return agent ? [{ key, title: agent.name, description: 'Agent', path: `/chat/${pin.id}`, unread: agent.unread, mentioned: agent.mentioned }] : [];
  });
  return { entries, loading, error: errors[0]?.message };
}
