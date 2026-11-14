// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PageScreen } from './PageScreen';

const fixture = vi.hoisted(() => ({
  page: { _id: 'page-1', title: 'Plan', kind: 'page', parentId: 'parent', canEdit: true, archived: false, recordId: null, ancestors: [] } as { _id: string; title: string; kind: string; parentId: string | null; canEdit: boolean; archived: boolean; recordId: string | null; ancestors: [] } | null,
  destinations: [{ _id: 'folder', title: 'Projects', kind: 'folder', canEdit: true }, { _id: 'other', title: 'Other page', kind: 'page', canEdit: true }],
  loading: false,
  content: undefined as string | null | undefined,
  dirty: false,
  write: vi.fn(async (_args: unknown) => {}),
  complete: vi.fn(),
  confirm: vi.fn(async () => true),
}));
vi.mock('react-native', () => ({ View: ({ children }: { children: ReactNode }) => createElement('div', null, children), ScrollView: ({ children }: { children: ReactNode }) => createElement('div', null, children) }));
vi.mock('@expo/material-symbols/add.xml', () => ({ default: 1 }));
vi.mock('@/features/drive/DriveListing', () => ({ DriveList: () => null, pickFiles: async () => [], useDriveLevel: () => ({ rows: [] }) }));
vi.mock('@/features/drive/uploads', () => ({ useDriveUploads: () => ({ uploads: [], start: () => {}, dismiss: () => {} }) }));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock('@/design', () => ({ useTheme: () => ({ sizes: { gutter: 20 }, spacing: { sm: 8, lg: 20 } }) }));
vi.mock('@/features/pins/usePins', () => ({ usePinAction: () => ({ label: 'Pin', onPress: vi.fn() }) }));
vi.mock('@/features/arrangements/useArrangements', () => ({ useArrangements: () => ({ writable: false, order: (_key: string, rows: unknown[]) => rows }) }));
vi.mock('@/features/access/AccessSheet', () => ({ AccessSheet: () => null }));
vi.mock('./DocumentEditor', () => ({ DocumentEditor: () => createElement('p', null, 'Document'), VersionDocument: () => createElement('p', null, 'Version content') }));
vi.mock('./PagesScreen', () => ({ PageChildren: () => null, PageOrganizer: () => null, NewPage: () => null, openPage: vi.fn(), useDriveNew: () => ({ items: [], sheet: null, error: undefined }) }));
vi.mock('./Confirm', () => ({ useDocumentConfirm: () => ({ confirm: fixture.confirm, dialog: null }) }));
vi.mock('@/components/ui/ContentToolbar', () => ({ ContentToolbar: () => null }));
vi.mock('@/lib/useTask', () => ({ useTask: () => ({ busy: false, error: undefined, clear: vi.fn(), run: async (job: () => Promise<unknown>) => job() }) }));
vi.mock('@/lib/useDraftGuard', () => ({ useDraftGuard: ({ dirty, onClose }: { dirty: boolean; onClose: () => void }) => { fixture.dirty = dirty; return { dismissible: !dirty, close: onClose, complete: fixture.complete, dialog: null }; } }));
vi.mock('@/lib/convex', () => ({
  useQuery: (query: FunctionReference<'query'>) => {
    const name = getFunctionName(query);
    return name === 'pages:get' ? fixture.page : name === 'pages:version' ? fixture.content : fixture.loading ? undefined : fixture.destinations;
  },
  usePaginatedQuery: (query: FunctionReference<'query'>) => ({
    results: getFunctionName(query) === 'pages:children' ? fixture.destinations : [{ _id: 'current', time: 2, user: 'Jaden', others: [] }, { _id: 'older', time: 1, user: 'Jaden', others: [] }],
    status: fixture.loading ? 'LoadingFirstPage' : 'Exhausted', loadMore: vi.fn(),
  }),
  useMutation: () => fixture.write,
}));
vi.mock('@/components/navigation/HeaderMenu', () => ({ HeaderMenu: ({ actions, onAction }: { actions: { id: string; title: string; disabled?: boolean }[]; onAction: (id: string) => void }) => actions.map(action => createElement('button', { key: action.id, disabled: action.disabled, onClick: () => onAction(action.id) }, action.title)) }));
vi.mock('@/components/ui', () => {
  const container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const button = ({ label, title, disabled, onPress }: { label?: string; title?: string; disabled?: boolean; onPress?: () => void }) => createElement('button', { disabled, onClick: onPress }, label ?? title);
  return {
    Button: button, ListRow: button, Screen: container, Text: container,
    Badge: ({ label }: { label: string }) => createElement('p', null, label),
    EmptyState: ({ title }: { title: string }) => createElement('p', null, title),
    Loading: ({ label }: { label?: string }) => createElement('p', null, label ?? 'Loading'),
    ErrorState: ({ message }: { message: string }) => createElement('p', { role: 'alert' }, message),
    ChoicePicker: () => null,
    Field: ({ label, value, onChangeText, editable }: { label: string; value: string; onChangeText: (value: string) => void; editable: boolean }) => createElement('input', { 'aria-label': label, value, disabled: !editable, onInput: (event: { currentTarget: HTMLInputElement }) => onChangeText(event.currentTarget.value) }),
    EditorSheet: ({ children, submit, onClose }: { children: ReactNode; submit?: { label?: string; disabled?: boolean; onPress: () => void }; onClose: () => void }) => createElement('section', null, createElement('button', { onClick: onClose }, submit ? 'Cancel' : 'Close'), submit && button(submit), children),
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const render = () => root.render(createElement(PageScreen, { pageId: 'page-1' }));
const button = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent === label);
const input = () => host.querySelector<HTMLInputElement>('input')!;
const type = async (value: string) => { await act(async () => { input().value = value; input().dispatchEvent(new Event('input', { bubbles: true })); }); };
beforeEach(async () => {
  fixture.page = { _id: 'page-1', title: 'Plan', kind: 'page', parentId: 'parent', canEdit: true, archived: false, recordId: null, ancestors: [] };
  fixture.loading = false; fixture.content = undefined; fixture.dirty = false;
  fixture.write.mockClear(); fixture.complete.mockClear(); fixture.confirm.mockReset().mockResolvedValue(true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => render());
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it('keeps rename drafts after edit permission loss and blocks an observed remote title overwrite', async () => {
  await act(async () => button('Rename')!.click());
  expect(button('Done')!.disabled).toBe(true);
  expect(button('Save title')).toBeUndefined();
  await type('My draft');
  fixture.page!.canEdit = false;
  await act(async () => render());
  expect(input().value).toBe('My draft');
  expect(input().disabled).toBe(true);
  expect(fixture.dirty).toBe(true);
  expect(button('Done')!.disabled).toBe(true);
  fixture.page!.canEdit = true; fixture.page!.title = 'Remote rename';
  await act(async () => render());
  expect(input().value).toBe('My draft');
  expect(button('Done')!.disabled).toBe(true);
  expect(fixture.write).not.toHaveBeenCalled();
  await act(async () => button('Reload latest')!.click());
  expect(input().value).toBe('Remote rename');
  expect(fixture.dirty).toBe(false);
  await type('New   name');
  await act(async () => button('Done')!.click());
  expect(fixture.write).toHaveBeenCalledWith({ pageId: 'page-1', title: 'New name' });
  expect(fixture.complete).toHaveBeenCalledOnce();
  expect(host.querySelector('section')).toBeNull();
});

it('shows destination loading, respects folder-only nesting, and disables moves after archiving', async () => {
  fixture.page!.kind = 'folder'; fixture.loading = true;
  await act(async () => render());
  await act(async () => button('Move to…')!.click());
  expect(host.textContent).toContain('Loading destinations');
  expect(button('Projects')).toBeUndefined();
  fixture.loading = false;
  await act(async () => render());
  expect(button('Projects')!.disabled).toBe(false);
  expect(button('Other page')).toBeUndefined();
  fixture.page!.archived = true;
  await act(async () => render());
  expect(button('Projects')!.disabled).toBe(true);
  expect(button('Top level')!.disabled).toBe(true);
  expect(fixture.write).not.toHaveBeenCalled();
});

it('moves pages into folders and closes only after the mutation succeeds', async () => {
  await act(async () => button('Move to…')!.click());
  expect(button('Other page')).toBeUndefined();
  await act(async () => button('Projects')!.click());
  expect(fixture.write).toHaveBeenCalledWith({ pageId: 'page-1', parentId: 'folder' });
  expect(host.querySelector('section')).toBeNull();
});

it('only offers restore for a loaded, available, noncurrent version', async () => {
  await act(async () => button('History')!.click());
  const versions = host.querySelectorAll('section button');
  await act(async () => (versions[versions.length - 1] as HTMLButtonElement).click());
  expect(button('Restore this version')).toBeUndefined();
  fixture.content = null;
  await act(async () => render());
  expect(host.textContent).toContain('Version unavailable');
  expect(button('Restore this version')).toBeUndefined();
  fixture.content = '{}';
  await act(async () => render());
  expect(button('Restore this version')).toBeDefined();
  fixture.page!.archived = true;
  await act(async () => render());
  expect(button('Restore this version')).toBeUndefined();
});

it.each(['permission', 'access', 'version'] as const)('rechecks restore after %s loss while confirming', async (lost) => {
  fixture.content = '{}';
  let resolve!: (yes: boolean) => void;
  fixture.confirm.mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
  await act(async () => button('History')!.click());
  const versions = host.querySelectorAll('section button');
  await act(async () => (versions[versions.length - 1] as HTMLButtonElement).click());
  await act(async () => button('Restore this version')!.click());
  if (lost === 'permission') fixture.page!.canEdit = false;
  else if (lost === 'access') fixture.page = null;
  else fixture.content = null;
  await act(async () => render());
  await act(async () => resolve(true));
  expect(fixture.write).not.toHaveBeenCalled();
});
