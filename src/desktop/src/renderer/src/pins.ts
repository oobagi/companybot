import { useCallback } from "react";
import { useStoredIds } from "./arrangements";

export type PinKind = "chat" | "page" | "db" | "rec";
export type PinKey = `${PinKind}:${string}`;

/** Recents the rail shows, of the `RECENT_KEPT` saved. */
export const RECENT_SHOWN = 5;

/** The open workspace's personal pins and recents, shared by every live reader. */
export function usePins() {
	const [pins, changePins] = useStoredIds("pins");
	const [recent, changeRecent, canSaveRecent] = useStoredIds("recent");
	const toggle = useCallback((key: PinKey) => {
		changePins({ op: pins.includes(key) ? "remove" : "add", id: key });
	}, [changePins, pins]);
	const visit = useCallback((key: PinKey) => changeRecent({ op: "visit", id: key }), [changeRecent]);
	return { pins: pins as PinKey[], recent: recent as PinKey[], toggle, visit, canSaveRecent };
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
