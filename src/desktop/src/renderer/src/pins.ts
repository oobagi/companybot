import { useCallback } from "react";
import { useStoredIds } from "./sortable";
import { useWorkspace } from "./convex";

export type PinKind = "chat" | "page" | "db" | "rec";
export type PinKey = `${PinKind}:${string}`;

/** Recents kept, so a few can be pinned or deleted and some still show. The rail shows `RECENT_SHOWN`. */
const RECENT_KEPT = 12;
export const RECENT_SHOWN = 5;

/** The open workspace's personal pins and recents, shared by every live reader. */
export function usePins() {
	const workspace = useWorkspace()?.id ?? "";
	const [pins, savePins] = useStoredIds(`rail.pins:${workspace}`);
	const [recent, saveRecent, ready] = useStoredIds(`rail.recent:${workspace}`);
	const toggle = useCallback((key: PinKey) => {
		savePins((now) => now.includes(key) ? now.filter((k) => k !== key) : [...now, key]);
	}, [savePins]);
	const visit = useCallback((key: PinKey) => {
		saveRecent((now) => now[0] === key ? now : [key, ...now.filter((k) => k !== key)].slice(0, RECENT_KEPT));
	}, [saveRecent]);
	return { pins: pins as PinKey[], recent: recent as PinKey[], toggle, visit, ready };
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
