import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache";
import { api } from "../../api";
import type { Refs } from "./logic";

export type RecordType = FunctionReturnType<typeof api.recordTypes.list>[number];
export type Row = FunctionReturnType<typeof api.records.search>[number];

/** Every live record type with its fields (archived ones last). */
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
