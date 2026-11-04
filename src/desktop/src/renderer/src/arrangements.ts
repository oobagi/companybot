import { arrangementLists, legacyArrangement, type ArrangementList } from "@companybot/core/arrangements";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { OptimisticUpdate } from "convex/browser";
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { useMutation, useQuery } from "./convex";

type Data = NonNullable<FunctionReturnType<typeof api.arrangements.get>>;
type State = { data: Data; error?: string; fail: (error?: unknown) => void };
const Context = createContext<State | null>(null);
export function ArrangementProvider({ data, children }: { data: Data; children: React.ReactNode }) {
	const [error, setError] = useState<string>();
	const fail = useCallback((error?: unknown) => setError(error === undefined ? undefined : errorMessage(error)), []);
	return createElement(Context.Provider, { value: { data, error, fail } }, children);
}
export const useArrangementState = () => useContext(Context);

export const optimisticArrangements: OptimisticUpdate<FunctionArgs<typeof api.arrangements.set>> = (store, args) => {
	for (const query of store.getAllQueries(api.arrangements.get)) {
		if (query.args.workspaceId !== args.workspaceId || !query.value) continue;
		const rows = query.value.rows.filter((r) => r.list !== args.list || r.entityId !== args.entityId);
		store.setQuery(api.arrangements.get, query.args, { ...query.value, rows: [...rows, { list: args.list, entityId: args.entityId, ids: args.ids }] });
	}
};

const empty: string[] = [];
/** Every list reads the loaded shell context; no per-list subscriptions or local fallback. */
export function useStoredIds(list: ArrangementList, entityId?: string) {
	const state = useContext(Context);
	const mutate = useMutation(api.arrangements.set, optimisticArrangements);
	const ids = state?.data.rows.find((r) => r.list === list && r.entityId === entityId)?.ids ?? empty;
	const current = useRef(ids);
	current.current = ids;
	const writable = !!state && (arrangementLists[list].scope !== "shared" || state.data.writable);
	const fail = state?.fail;
	const save = useCallback((next: string[] | ((before: string[]) => string[])) => {
		if (!writable) return;
		const ids = typeof next === "function" ? next(current.current) : next;
		if (ids === current.current) return;
		current.current = ids;
		fail?.();
		void mutate({ list, entityId, ids }).catch(fail);
	}, [list, entityId, writable, mutate, fail]);
	return [ids, save, writable] as const;
}

type Storage = Pick<globalThis.Storage, "length" | "key" | "getItem" | "removeItem">;
type Import = FunctionArgs<typeof api.arrangements.migrate>;
type Display = FunctionArgs<typeof api.recordTypes.migrateDisplay>;
/** Failed keys stay for the next launch; an unavailable upload must not prevent opening the app. */
export async function migrateArrangements(storage: Storage, upload: (args: Import) => Promise<unknown>, uploadDisplay: (args: Display) => Promise<unknown>) {
	const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => !!key && (!!legacyArrangement(key) || /^(rail\.(pins|recent)|sidebar\.(channels|dms|databases|pages)|pages-expanded:|views\.order:|records\.(columns|layout)\.)/.test(key)));
	for (const key of keys) {
		try {
			const target = legacyArrangement(key);
			// Recents could belong to the previous person on a shared computer. Rebuild them.
			if (!target || target.list === "recent") { storage.removeItem(key); continue; }
			let value: unknown;
			try { value = JSON.parse(storage.getItem(key) ?? "null"); } catch { /* Discard malformed local data. */ }
			if (target.list === "layout") {
				const layout = value as { layout?: string; groupBy?: string } | null;
				await uploadDisplay({ databaseKey: target.databaseKey!, display: { layout: layout?.layout === "board" ? "board" : "table", ...(typeof layout?.groupBy === "string" && { groupBy: layout.groupBy }) } });
			} else {
				let ids = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && !!id && id.length <= 256))].slice(0, 4000) : [];
				while (JSON.stringify(ids).length > 128_000) ids.pop();
				// Old pins have no account identity: the first signed-in person here claims them.
				await upload({ list: target.list, entityId: target.entityId, databaseKey: target.databaseKey, targetWorkspaceId: target.workspaceId, ids });
			}
			storage.removeItem(key);
		} catch (error) { console.error("Could not import arrangement", key, error); }
	}
}

export function useArrangementMigration(userId?: string) {
	const upload = useMutation(api.arrangements.migrate);
	const uploadDisplay = useMutation(api.recordTypes.migrateDisplay);
	const [done, setDone] = useState(false);
	useEffect(() => {
		if (!userId) return;
		let active = true;
		void migrateArrangements(localStorage, upload, uploadDisplay).catch(console.error).finally(() => { if (active) setDone(true); });
		return () => { active = false; };
	}, [userId, upload, uploadDisplay]);
	return done;
}

/** Mount children only after import and the complete workspace snapshot have settled. */
export function LoadedArrangements({ userId, children }: { userId: string; children: React.ReactNode }) {
	const imported = useArrangementMigration(userId);
	const data = useQuery(api.arrangements.get, imported ? {} : "skip");
	return imported && data ? createElement(ArrangementProvider, { data, children }) : null;
}
