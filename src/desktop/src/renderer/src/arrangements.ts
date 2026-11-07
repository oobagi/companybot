import { applyCommand, arrangementLists, legacyArrangement, type ArrangementCommand, type ArrangementList } from "@companybot/core/arrangements";
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

/** The server's own change, applied to the cached list so it shows at once (core `applyCommand`). */
export const optimisticArrangements: OptimisticUpdate<FunctionArgs<typeof api.arrangements.change>> = (store, { list, entityId, command, workspaceId }) => {
	for (const query of store.getAllQueries(api.arrangements.get)) {
		if (query.args.workspaceId !== workspaceId || !query.value) continue;
		const old = query.value.rows.find((r) => r.list === list && r.entityId === entityId);
		const rows = query.value.rows.filter((r) => r !== old);
		store.setQuery(api.arrangements.get, query.args, { ...query.value, rows: [...rows, { list, entityId, ids: applyCommand(old?.ids, command) }] });
	}
};
/** Module-level, so `useMutation` stays stable between renders. */
const arrangementsUpdate = () => optimisticArrangements;

const empty: string[] = [];
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
const rowOf = (state: State | null, list: ArrangementList, entityId?: string) => state?.data.rows.find((r) => r.list === list && r.entityId === entityId);
const writableIn = (state: State | null, list: ArrangementList) => !!state && (arrangementLists[list].scope !== "shared" || state.data.writable);

/**
 * Lists picked when they change, not when rendering (a drop into any Drive folder): `ids` reads one as
 * loaded now; `change` sends it one command, as `useStoredIds` does.
 */
export function useArrangements() {
	const state = useContext(Context);
	const latest = useRef(state);
	latest.current = state;
	const mutate = useMutation(api.arrangements.change, arrangementsUpdate);
	const ids = useCallback((list: ArrangementList, entityId?: string) => rowOf(latest.current, list, entityId)?.ids ?? empty, []);
	/**
	 * `after`: the mutation this one needs first (a move into the level it orders), sent just before it:
	 * Convex runs a client's mutations in order. If that one fails, this one does too, and only that
	 * one's error shows.
	 */
	const change = useCallback((list: ArrangementList, entityId: string | undefined, command: ArrangementCommand, after?: Promise<unknown>) => {
		const now = latest.current;
		if (!now || !writableIn(now, list)) return;
		const row = rowOf(now, list, entityId);
		if (row && same(applyCommand(row.ids, command), row.ids)) return;
		now.fail();
		void mutate({ list, entityId, command }).catch((error) => (after ? after.then(() => now.fail(error), () => {}) : now.fail(error)));
	}, [mutate]);
	return { ids, change };
}

/**
 * A list from the loaded shell context, and `change` to send one command for it. Commands, not whole
 * lists, so a change from another device since this one loaded is kept.
 */
export function useStoredIds(list: ArrangementList, entityId?: string) {
	const state = useContext(Context);
	const { change: send } = useArrangements();
	const change = useCallback((command: ArrangementCommand) => send(list, entityId, command), [send, list, entityId]);
	return [rowOf(state, list, entityId)?.ids ?? empty, change, writableIn(state, list)] as const;
}

type Storage = Pick<globalThis.Storage, "length" | "key" | "getItem" | "removeItem">;
type Import = FunctionArgs<typeof api.arrangements.migrate>;
type Display = FunctionArgs<typeof api.recordTypes.migrateDisplay>;
/** COMPAT(0.1.0-alpha.10): the one-time localStorage import; delete with `arrangements.migrate`. Failed keys stay for the next launch; an unavailable upload must not prevent opening the app. */
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
