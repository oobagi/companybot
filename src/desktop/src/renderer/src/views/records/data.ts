import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { usePaginatedQuery, useQuery } from "../../convex";
import type { Refs } from "./logic";

export type RecordType = FunctionReturnType<typeof api.recordTypes.list>[number];
export type Row = FunctionReturnType<typeof api.records.search>[number];

export type Sort = { field: string; order: "asc" | "desc" };
/** What `records.list` takes; `group` is one board column. */
export type ListArgs = { typeId: Id<"recordTypes">; filters: Record<string, unknown>[]; sort?: Sort; group?: { field: string; option: string | null } };

/** Every live database with its fields (ones in Trash last, marked `archived`). */
export const useTypes = () => useQuery(api.recordTypes.list);

/**
 * Names for the people and records in `rows`. A page resolves most itself; ids past its
 * read budget come back `unresolved` and are looked up here, 200 at a time.
 */
export function useRefs(rows: Pick<Row, "refs" | "unresolved">[]): Refs {
	const missing = [...new Set(rows.flatMap((r) => r.unresolved))].slice(0, 200);
	const more = useQuery(api.records.refs, missing.length ? { ids: missing } : "skip");
	return Object.assign({}, ...rows.map((r) => r.refs), more);
}

/** The workspace's currency: what new amounts default to. */
export const useCurrency = () => useQuery(api.workspace.settings)?.currency ?? "USD";

/** A table's search: matches best first, filters and sort aside (`records.searchList`). */
export type SearchArgs = { typeId: Id<"recordTypes">; query: string };

/**
 * Rows of a list, or of a table's search (`SearchArgs`), loading more as `setEnd`'s element scrolls
 * into view. Short pages with more to come keep loading.
 */
export function usePagedRows(args: ListArgs | SearchArgs) {
	const fn = "query" in args ? api.records.searchList : api.records.list;
	const { results, status: live, loadMore } = usePaginatedQuery(fn as typeof api.records.list, args as never, { initialNumItems: 25 });
	// A new sort or filter loads a new first page: keep showing the last list meanwhile, so it doesn't flash.
	const last = useRef<{ rows: Row[]; status: typeof live }>(undefined);
	if (live !== "LoadingFirstPage") last.current = { rows: results as Row[], status: live };
	const stale = live === "LoadingFirstPage" && !!last.current;
	const rows = stale ? last.current!.rows : (results as Row[]);
	const status = stale ? last.current!.status : live;
	const refs = useRefs(rows);
	const [end, setEnd] = useState<HTMLDivElement | null>(null);
	const [atEnd, setAtEnd] = useState(false);
	useEffect(() => {
		if (!end) return;
		const observer = new IntersectionObserver(([e]) => setAtEnd(!!e?.isIntersecting), { rootMargin: "200px" });
		observer.observe(end);
		return () => observer.disconnect();
	}, [end]);
	// Re-checked after every page, so a short page (isDone false) asks again while the end is in view.
	useEffect(() => {
		if (atEnd && live === "CanLoadMore") loadMore(25);
	}, [atEnd, live, rows.length, loadMore]);
	return { rows, refs, status, stale, loadMore, setEnd };
}
