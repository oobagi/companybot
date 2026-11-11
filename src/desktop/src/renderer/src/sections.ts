import { applyCommand, sectionTabs, type SectionTab } from "@companybot/core/arrangements";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { OptimisticUpdate } from "convex/browser";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useCallback, useMemo } from "react";
import { api } from "./api";
import { useArrangementState, useStoredIds } from "./arrangements";
import { useMutation } from "./convex";
import { applyOrder, moveCommand, useSortable } from "./sortable";

// The sections people add to Chat's, Drive's, Databases' and Inbox's sidebars (backend sidebarSections.ts), from
// the loaded arrangements, so a tab's layout shows in one piece. Views draw them with `SectionsNav`.

export type Section = NonNullable<FunctionReturnType<typeof api.arrangements.get>>["sections"][number];
export type SectionId = Id<"sidebarSections">;

/** The drag group a tab's rows share, so they move between its sections and the list in none. */
export const itemsGroup = (tab: SectionTab) => `sidebar:${tab}`;
/** The list key of a tab's rows in no section: the first section's header ends it, so it takes drops while empty. */
export const unsectionedList = (tab: SectionTab) => `sidebar:${tab}:none`;

/** The server's own move, applied to the cached layout so a drop shows at once. */
const placeAtOnce: OptimisticUpdate<FunctionArgs<typeof api.sidebarSections.place>> = (store, { tab, id, sectionId, beforeId, fill, workspaceId }) => {
	for (const query of store.getAllQueries(api.arrangements.get)) {
		if (query.args.workspaceId !== workspaceId || !query.value) continue;
		const sections = query.value.sections.map((s) => (s._id === sectionId ? { ...s, ids: applyCommand(s.ids, { op: "move", id, beforeId }) } : s.ids.includes(id) ? { ...s, ids: s.ids.filter((k) => k !== id) } : s));
		let rows = query.value.rows;
		if (!sectionId) {
			const list = sectionTabs[tab];
			const old = rows.find((r) => r.list === list && !r.entityId);
			rows = [...rows.filter((r) => r !== old), { list, ids: applyCommand(old?.ids, { op: "move", id, beforeId, fill }) }];
		}
		store.setQuery(api.arrangements.get, query.args, { ...query.value, rows, sections });
	}
};
/** Module-level, so `useMutation` stays stable between renders. */
const placeUpdate = () => placeAtOnce;
const none: Section[] = [];
const sectionKey = (s: Section) => s._id;

/**
 * A tab's sections in their shared order, the ids they hold (`held`: drawn there, not in the list in
 * none), and `place` to move a row into one (or back with `sectionId` null). `writable`: `sidebar.arrange`.
 */
export function useSections(tab: SectionTab) {
	const state = useArrangementState();
	const [order, , writable] = useStoredIds("sectionOrder");
	const all = state?.data.sections ?? none;
	const sections = useMemo(() => applyOrder(order, all.filter((s) => s.tab === tab), sectionKey), [order, all, tab]);
	const held = useMemo(() => new Set(sections.flatMap((s) => s.ids)), [sections]);
	const mutate = useMutation(api.sidebarSections.place, placeUpdate);
	const fail = state?.fail;
	const place = useCallback((id: string, sectionId: SectionId | null, beforeId: string | null = null, fill?: string[]) => {
		if (!writable) return;
		fail?.();
		void mutate({ tab, id, sectionId, beforeId, fill }).catch(fail);
	}, [tab, writable, mutate, fail]);
	return { sections, held, place, writable };
}

/**
 * A tab's rows in no section (Chat's channels, the databases, Inbox's rows), in the tab's shared order: drag them
 * within it, and rows from its sections land in it where they're dropped.
 */
export function useUnsectioned<T>(tab: "chat" | "databases" | "inbox", items: readonly T[], id: (item: T) => string) {
	const { held, place } = useSections(tab);
	const list = sectionTabs[tab];
	const [order] = useStoredIds(list);
	const unsectioned = useMemo(() => items.filter((item) => !held.has(id(item))), [items, held, id]);
	return useSortable(list, unsectioned, id, "y", undefined, {
		id: unsectionedList(tab),
		group: itemsGroup(tab),
		onReceive: (from, index, shown) => { const at = dropAt(order, shown, from.id, index); place(from.id, null, at.beforeId, at.fill); },
	});
}

/**
 * Where a row from another list lands at `index` of `shown` (the list as drawn, without it): before
 * the row there, with the ids drawn above it but never saved (`fill`), so it lands where it looked.
 */
export function dropAt(saved: readonly string[], shown: readonly string[], id: string, index: number) {
	const command = moveCommand(saved, shown.filter((k) => k !== id), id, index);
	return command?.op === "move" ? { beforeId: command.beforeId, fill: command.fill } : { beforeId: null };
}
