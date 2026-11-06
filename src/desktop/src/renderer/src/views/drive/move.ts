import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { OptimisticUpdate } from "convex/browser";
import type { FunctionArgs } from "convex/server";
import { insertAtPosition } from "convex/react";
import { api } from "../../api";
import { useArrangements } from "../../arrangements";
import { useFetch, useMutation } from "../../convex";
import { applyOrder, moveCommand } from "../../sortable";

// Moving Drive rows by dragging them (wiki/drive.md): into a folder or page, or between the rows of a
// level. Each move shows at once and saves the row's place in its new level's order with it.

type PageId = Id<"pages">;
/** A dragged Drive row: enough to tell where it may go. `parentId`: the level it's in. */
export type DriveItem = { kind: "page" | "folder" | "file"; id: string; canEdit: boolean; parentId?: PageId };

type PageMove = FunctionArgs<typeof api.pages.move>;
type FileMove = FunctionArgs<typeof api.driveFiles.move>;

/** Its new parent has something under it now (the sidebar shows its chevron). */
function markParent(store: Parameters<OptimisticUpdate<PageMove>>[0], workspaceId: PageMove["workspaceId"], parentId: PageId | undefined) {
	if (!parentId) return;
	for (const { args, value } of store.getAllQueries(api.pages.children)) {
		if (args.workspaceId !== workspaceId || !value?.page.some((p) => p._id === parentId)) continue;
		store.setQuery(api.pages.children, args, { ...value, page: value.page.map((p) => (p._id === parentId ? { ...p, hasChildren: true } : p)) });
	}
}

/**
 * Out of its old level and last into its new one (where loaded to the end), until the server answers. The
 * same drop saves its place there (`moveCommand`), which the arrangement's own update shows at once.
 */
const pageMoved: OptimisticUpdate<PageMove> = (store, { pageId, parentId, workspaceId }) => {
	const levels = store.getAllQueries(api.pages.children).filter((q) => q.args.workspaceId === workspaceId && q.value);
	const row = levels.flatMap((q) => q.value!.page).find((p) => p._id === pageId);
	if (!row) return;
	for (const { args, value } of levels) {
		if (args.parentId !== parentId && value!.page.some((p) => p._id === pageId)) store.setQuery(api.pages.children, args, { ...value!, page: value!.page.filter((p) => p._id !== pageId) });
	}
	const last = levels.find((q) => q.args.parentId === parentId && q.value!.isDone);
	if (last && !levels.some((q) => q.args.parentId === parentId && q.value!.page.some((p) => p._id === pageId))) {
		store.setQuery(api.pages.children, last.args, { ...last.value!, page: [...last.value!.page, { ...row, parentId: parentId ?? null }] });
	}
	markParent(store, workspaceId, parentId);
};

/** Files are listed by name, so it goes in at its name's place. */
const fileMoved: OptimisticUpdate<FileMove> = (store, { fileId, parentId, workspaceId }) => {
	const levels = store.getAllQueries(api.driveFiles.children).filter((q) => q.args.workspaceId === workspaceId && q.value);
	const row = levels.flatMap((q) => q.value!.page).find((f) => f._id === fileId);
	if (!row) return;
	for (const { args, value } of levels) {
		if (value!.page.some((f) => f._id === fileId)) store.setQuery(api.driveFiles.children, args, { ...value!, page: value!.page.filter((f) => f._id !== fileId) });
	}
	insertAtPosition({ paginatedQuery: api.driveFiles.children, argsToMatch: { workspaceId, parentId }, sortOrder: "asc", sortKeyFromItem: (f) => f.name, localQueryStore: store, item: { ...row, parentId: parentId ?? null } });
	markParent(store, workspaceId, parentId);
};

const rowId = (p: { _id: string }) => p._id;

/** What dropping a Drive row does. `run` shows a failed move (useRun); the row goes back where it was. */
export function useDriveMoves(run: (action: Promise<unknown>) => unknown) {
	const movePage = useMutation(api.pages.move, () => pageMoved);
	const moveFile = useMutation(api.driveFiles.move, () => fileMoved);
	const arrangements = useArrangements();
	const read = useFetch();
	return {
		/** Between the rows of `parentId`'s level, at `index` of what it shows there (`shown`, without it). */
		to: (item: DriveItem, parentId: PageId | undefined, shown: string[], index: number) => {
			const moved = movePage({ pageId: item.id as PageId, parentId });
			run(moved);
			const command = moveCommand(arrangements.ids("pages", parentId), shown, item.id, index);
			if (command) arrangements.change("pages", parentId, command, moved);
		},
		/** Into a folder or page (`parentId`; none for the top level), last in its order. */
		into: (item: DriveItem, parentId: PageId | undefined) => {
			if (item.kind === "file") return void run(moveFile({ fileId: item.id as Id<"driveFiles">, parentId }));
			const moved = movePage({ pageId: item.id as PageId, parentId });
			run(moved);
			// Last among what that level shows, which may be open nowhere: read it once the move is in. If
			// that read fails, the row is still moved, just not placed last.
			void moved.then(async () => {
				const level = await read(api.pages.children, { parentId, paginationOpts: { numItems: 50, cursor: null } });
				const saved = arrangements.ids("pages", parentId);
				const shown = applyOrder(saved, level.page, rowId).map(rowId);
				const command = moveCommand(saved, shown, item.id, shown.length);
				if (command) arrangements.change("pages", parentId, command);
			}).catch(() => {});
		},
	};
}
export type DriveMoves = ReturnType<typeof useDriveMoves>;
