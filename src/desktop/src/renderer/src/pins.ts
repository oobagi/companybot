import { useCallback, useSyncExternalStore } from "react";
import { useWorkspace } from "./convex";

// Pins and recents: what you keep at hand in the rail, under its tabs. Each is a key, "kind:id":
// a chat (channel, DM, agent DM or side chat), a page, a database, or one record. Per workspace, on this
// computer (localStorage), like the sidebar's order. Every component reading a list sees a change
// at once: one store, shared.

export type PinKind = "chat" | "page" | "db" | "rec";
export type PinKey = `${PinKind}:${string}`;

/** Recents kept, so a few can be pinned or deleted and some still show. The rail shows `RECENT_SHOWN`. */
const RECENT_KEPT = 12;
export const RECENT_SHOWN = 5;

const lists = new Map<string, PinKey[]>();
const listeners = new Set<() => void>();

const isKey = (k: unknown): k is PinKey => typeof k === "string" && /^(chat|page|db|rec):./.test(k);

function read(storeKey: string): PinKey[] {
	let list = lists.get(storeKey);
	if (!list) {
		try {
			const saved = JSON.parse(localStorage.getItem(storeKey) ?? "[]");
			list = Array.isArray(saved) ? saved.filter(isKey) : [];
		} catch {
			list = [];
		}
		lists.set(storeKey, list);
	}
	return list;
}

function write(storeKey: string, list: PinKey[]) {
	lists.set(storeKey, list);
	try {
		localStorage.setItem(storeKey, JSON.stringify(list));
	} catch {
		// Storage may be unavailable; it still holds until reload.
	}
	for (const l of listeners) l();
}

const subscribe = (onChange: () => void) => (listeners.add(onChange), () => void listeners.delete(onChange));

/** The open workspace's pins (in the order pinned; the rail keeps your drag order) and recents (newest first). */
export function usePins() {
	const workspace = useWorkspace()?.id ?? "";
	const pinsKey = `rail.pins:${workspace}`;
	const recentKey = `rail.recent:${workspace}`;
	const pins = useSyncExternalStore(subscribe, () => read(pinsKey));
	const recent = useSyncExternalStore(subscribe, () => read(recentKey));
	const toggle = useCallback(
		(key: PinKey) => {
			const now = read(pinsKey);
			write(pinsKey, now.includes(key) ? now.filter((k) => k !== key) : [...now, key]);
		},
		[pinsKey],
	);
	const visit = useCallback(
		(key: PinKey) => {
			const now = read(recentKey);
			if (now[0] !== key) write(recentKey, [key, ...now.filter((k) => k !== key)].slice(0, RECENT_KEPT));
		},
		[recentKey],
	);
	return { pins, recent, toggle, visit };
}

/** What a screen's path shows, if it's something you can pin: a record's page is the record. */
export function pinOf(route: string[]): PinKey | undefined {
	const [view, id, recordId] = route;
	if (!id) return undefined;
	if (view === "chat") return `chat:${id}`;
	if (view === "pages") return `page:${id}`;
	if (view === "records") return recordId ? `rec:${recordId}` : `db:${id}`;
	return undefined;
}

/** A pin's kind and id. */
export function splitPin(key: PinKey): [PinKind, string] {
	const at = key.indexOf(":");
	return [key.slice(0, at) as PinKind, key.slice(at + 1)];
}

/** Where a pin opens. A record's path needs its database, which `typeKey` gives. */
export function pathOf(key: PinKey, typeKey?: string): string[] {
	const [kind, id] = splitPin(key);
	if (kind === "chat") return ["chat", id];
	if (kind === "page") return ["pages", id];
	if (kind === "rec") return ["records", typeKey ?? "", id];
	return ["records", id];
}
