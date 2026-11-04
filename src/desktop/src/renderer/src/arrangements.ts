import { arrangementScope } from "@companybot/core/arrangements";
import type { FunctionArgs } from "convex/server";
import type { OptimisticUpdate } from "convex/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useMutation, useQuery } from "./convex";

const empty: string[] = [];
const optimistic: OptimisticUpdate<FunctionArgs<typeof api.arrangements.set>> = (store, args) => {
	for (const query of store.getAllQueries(api.arrangements.get)) {
		if (query.args.key === args.key && (args.key === "rail.order" || query.args.workspaceId === args.workspaceId) && query.value?.writable) {
			store.setQuery(api.arrangements.get, query.args, { ...query.value, ids: args.ids });
		}
	}
};

/** A live ordered list. Convex's optimistic cache updates every reader at once. */
export function useArrangement(key: string) {
	const value = useQuery(api.arrangements.get, key ? { key } : "skip");
	const mutate = useMutation(api.arrangements.set, optimistic);
	const ids = value?.ids ?? empty;
	const current = useRef(ids);
	current.current = ids;
	const writable = value?.writable ?? false;
	const save = useCallback((next: string[] | ((before: string[]) => string[])) => {
		if (!writable) return;
		const ids = typeof next === "function" ? next(current.current) : next;
		if (ids === current.current) return;
		current.current = ids;
		void mutate({ key, ids }).catch(console.error);
	}, [key, writable, mutate]);
	return [ids, save, writable] as const;
}

type Storage = Pick<globalThis.Storage, "length" | "key" | "getItem" | "removeItem">;

/** Snapshot only migration keys: drafts, panel sizes and device preferences stay untouched. */
export async function migrateArrangements(storage: Storage, upload: (args: { key: string; ids: string[] }) => Promise<unknown>) {
	const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => !!key && (arrangementScope(key) !== undefined || /^(rail\.(pins|recent)|sidebar\.(channels|dms|databases|pages)|pages-expanded:|views\.order:|records\.(columns|layout)\.)/.test(key)));
	for (const key of keys) {
		let value: unknown;
		try { value = JSON.parse(storage.getItem(key) ?? "null"); } catch { /* Broken old values are discarded. */ }
		let ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && !!id && id.length <= 256) : [];
		if (key.startsWith("records.layout.")) {
			const layout = value as { layout?: string; groupBy?: string } | null;
			ids = layout?.layout === "board" ? ["board", ...(typeof layout.groupBy === "string" ? [layout.groupBy] : [])] : ["table"];
		}
		ids = [...new Set(ids)].filter((id) => !!id && id.length <= 256).slice(0, 4000);
		while (JSON.stringify(ids).length > 128_000) ids.pop();
		if (arrangementScope(key)) await upload({ key, ids });
		// A failed request leaves the key for retry. The server discards keys for things gone.
		storage.removeItem(key);
	}
}

/** Finish importing before screens can save defaults over the computer's old choices. */
export function useArrangementMigration(userId?: string) {
	const upload = useMutation(api.arrangements.migrate);
	const [done, setDone] = useState(false);
	const [error, setError] = useState<unknown>();
	useEffect(() => {
		if (!userId) return;
		let active = true;
		migrateArrangements(localStorage, upload).then(() => { if (active) setDone(true); }, (error) => { if (active) setError(error); });
		return () => { active = false; };
	}, [userId, upload]);
	return { done, error };
}
