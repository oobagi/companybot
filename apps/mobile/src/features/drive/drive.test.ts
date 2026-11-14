import { expect, it, vi } from 'vitest';

vi.mock('@/features/arrangements/useArrangements', () => ({ useArrangements: () => ({}) }));
vi.mock('@/lib/convex', () => ({ useQuery: () => undefined, usePaginatedQuery: () => undefined, useMutation: () => undefined, useWorkspace: () => undefined }));
vi.mock('@/lib/fileUpload', () => ({ useFileUpload: () => undefined }));
vi.mock('expo-document-picker', () => ({}));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/components/ui', () => ({}));
vi.mock('@/design', () => ({}));
vi.mock('@/design/icons', () => ({}));

const { foldersFirst } = await import('./DriveListing');
const { limiter } = await import('./uploads');

it('puts folders on top only when the level mixes them, each keeping its saved order', () => {
  const rows = [{ id: 'page', folder: false }, { id: 'b', folder: true }, { id: 'file', folder: false }, { id: 'a', folder: true }];
  expect(foldersFirst(rows, r => r.folder).map(r => r.id)).toEqual(['b', 'a', 'page', 'file']);
  expect(foldersFirst(rows.filter(r => r.folder), r => r.folder).map(r => r.id)).toEqual(['b', 'a']);
});

it('runs uploads a few at a time, in order, and a failed one holds up nothing', async () => {
  const inTurn = limiter(2);
  const started: number[] = [];
  const gates = [0, 1, 2].map(() => { let open!: () => void; const done = new Promise<void>(r => { open = r; }); return { done, open }; });
  const jobs = [0, 1, 2].map(i => inTurn(async () => { started.push(i); await gates[i]!.done; if (i === 0) throw new Error('failed'); return i; }));
  await Promise.resolve();
  expect(started).toEqual([0, 1]);
  gates[0]!.open();
  await expect(jobs[0]).rejects.toThrow('failed');
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
  gates[1]!.open(); gates[2]!.open();
  await expect(Promise.all(jobs.slice(1))).resolves.toEqual([1, 2]);
});
