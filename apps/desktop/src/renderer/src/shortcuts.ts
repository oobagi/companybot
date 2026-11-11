import { useEffect, useRef } from "react";
import { anyLayerOpen } from "./views/chat/common";

/**
 * The app's number shortcuts, one place for all three:
 * - ⌘1–9 open the rail's tabs in the order shown (Ctrl+1–9 off a Mac). They work while typing too,
 *   as in Slack: a digit with ⌘ types nothing.
 * - ⌥1–9 open the Nth row of the open tab's sidebar (Alt+1–9), even while typing.
 * - ⌃⌘1–9 switch to the Nth workspace in the switcher (Ctrl+Shift+1–9).
 * Keys are read by position (`e.code`, Digit1): Option+1 on a Mac types ¡, so `e.key` isn't 1.
 * A key something else already handled (the editor's own shortcuts) is left alone, and none fire
 * while a dialog or menu is open (`layers`): switching screens would unmount it and lose its form.
 */
export type Jump = { to: "tab" | "item" | "workspace"; n: number };

export const isMac = () => navigator.userAgent.includes("Mac");

/** Typing: in a field, or in the editor or composer. */
export const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function jumpOf(e: KeyboardEvent): Jump | undefined {
	const digit = /^Digit([1-9])$/.exec(e.code);
	if (!digit || e.isComposing || e.repeat || e.defaultPrevented || anyLayerOpen()) return undefined;
	const n = Number(digit[1]);
	const mods = `${e.metaKey ? "M" : ""}${e.ctrlKey ? "C" : ""}${e.altKey ? "A" : ""}${e.shiftKey ? "S" : ""}`;
	const [tab, workspace] = isMac() ? ["M", "MC"] : ["C", "CS"];
	if (mods === tab) return { to: "tab", n };
	if (mods === workspace) return { to: "workspace", n };
	if (mods === "A" && !(typing(e.target) && /^[ -~]$/.test(e.key) && !/^\d$/.test(e.key))) return { to: "item", n };
	return undefined;
}

/** How a shortcut reads in a tooltip or menu: ⌘2, ⌥3, ⌃⌘1 (Ctrl+2, Alt+3, Ctrl+Shift+1). */
export function shortcutLabel(to: Jump["to"], n: number) {
	const mac = isMac();
	const prefix = { tab: mac ? "⌘" : "Ctrl+", item: mac ? "⌥" : "Alt+", workspace: mac ? "⌃⌘" : "Ctrl+Shift+" }[to];
	return `${prefix}${n}`;
}

/** Calls `go(n)` for the given kind of number shortcut, and keeps the key from doing anything else. */
export function useJump(to: Jump["to"], go: (n: number) => boolean | void) {
	const latest = useRef(go);
	latest.current = go;
	useEffect(() => {
		const key = (e: KeyboardEvent) => {
			const jump = jumpOf(e);
			if (jump?.to !== to) return;
			// False: nothing there (a 7th tab), so the key does what it would have.
			if (latest.current(jump.n) !== false) e.preventDefault();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [to]);
}

/**
 * ⌥N: the Nth row of the open tab's sidebar, as shown. Rows are `Item`s at the top level (not a
 * sub-page or side chat) marked `data-sidebar-item`, inside `list`; a folded section's rows are
 * skipped, and "New …" rows aren't marked. Opening it is clicking it, so it does what a click does.
 */
export function sidebarRow(list: HTMLElement | null, n: number) {
	const rows = [...(list?.querySelectorAll<HTMLElement>("[data-sidebar-item]") ?? [])].filter((row) => !row.closest("[data-collapsed]"));
	return rows[n - 1];
}

export function blurActiveEditable() {
	const active = document.activeElement;
	if (active instanceof HTMLElement && typing(active)) active.blur();
}
