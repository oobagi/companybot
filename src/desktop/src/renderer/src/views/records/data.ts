import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
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

/** Rows of a list, loading more as `setEnd`'s element scrolls into view. Short pages with more to come keep loading. */
export function usePagedRows(args: ListArgs) {
	const { results, status, loadMore } = usePaginatedQuery(api.records.list, args as never, { initialNumItems: 25 });
	const rows = results as Row[];
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
		if (atEnd && status === "CanLoadMore") loadMore(25);
	}, [atEnd, status, rows.length, loadMore]);
	return { rows, refs, status, loadMore, setEnd };
}
