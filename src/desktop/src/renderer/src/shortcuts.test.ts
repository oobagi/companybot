// Number shortcuts: ⌘N opens the Nth rail tab in the order shown, ⌥N the Nth sidebar row, not while
// typing; the old G-then-a-letter keys do nothing. Also: an unpinned row's menu offers Pin to rail.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inApp } from "./testing";
import { AppRail, type AppTab } from "./views/AppRail";
import { Group, Item, SidebarList } from "./views/chat/Sidebar";

const saved = vi.hoisted(() => ({ tabs: [] as string[], pins: [] as string[] }));
vi.mock("./arrangements", () => ({ useStoredIds: (list: string) => [list === "tabs" ? saved.tabs : [], () => {}, true] }));
vi.mock("./pins", () => ({ usePins: () => ({ pins: saved.pins, recent: [], toggle: vi.fn(), visit: vi.fn(), canSaveRecent: true }) }));

let root: Root;
let host: HTMLElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", configurable: true });
	saved.tabs = [];
	saved.pins = [];
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});
afterEach(() => (act(() => root.unmount()), host.remove()));

const render = (node: React.ReactNode) => act(() => root.render(inApp(node)));
/** A key pressed on `target` (the page by default), as a Mac sends it: Option+3 is `£` but `Digit3`. */
const press = (code: string, mods: Partial<KeyboardEventInit> = {}, target: EventTarget = document.body) =>
	act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { code, key: code.replace("Key", "").toLowerCase(), bubbles: true, cancelable: true, ...mods })));

function rail(onOpen: (tab: AppTab) => void) {
	return h(AppRail, { tab: "chat", onOpen });
}

it("opens the Nth rail tab with ⌘N, in the order shown, even after a reorder", () => {
	const onOpen = vi.fn();
	render(rail(onOpen));
	press("Digit2", { metaKey: true });
	expect(onOpen).toHaveBeenLastCalledWith("drive");

	saved.tabs = ["customize", "databases"];
	render(rail(onOpen));
	press("Digit2", { metaKey: true });
	expect(onOpen).toHaveBeenLastCalledWith("databases");
	// Past the last tab, nothing.
	onOpen.mockClear();
	press("Digit9", { metaKey: true });
	expect(onOpen).not.toHaveBeenCalled();
});

it("opens a tab with ⌘N while typing a message, as in Slack", () => {
	const onOpen = vi.fn();
	render(rail(onOpen));
	const composer = document.body.appendChild(document.createElement("div"));
	composer.contentEditable = "true";
	press("Digit1", { metaKey: true }, composer);
	expect(onOpen).toHaveBeenCalledWith("chat");
	composer.remove();
});

it("no longer opens tabs with G then a letter", () => {
	const onOpen = vi.fn();
	render(rail(onOpen));
	for (const letter of ["C", "F", "D", "X"]) {
		press("KeyG");
		press(`Key${letter}`);
	}
	expect(onOpen).not.toHaveBeenCalled();
});

function sidebar(open: (name: string) => void) {
	const row = (name: string, more: { guides?: boolean[]; create?: boolean } = {}) => h(Item, { key: name, label: name, onClick: () => open(name), children: name, ...more });
	const folded = { collapsed: true, onToggle: () => {}, drag: { draggable: false, className: "" } as never };
	return h(SidebarList, {
		children: [
			h(Group, { key: "folded", title: "Folded", section: folded, children: row("Unread in a folded section") }),
			h(Group, { key: "channels", title: "Channels", children: [row("sales"), row("a sales thread", { guides: [false] }), row("support")] }),
			h(Group, { key: "dms", title: "Direct messages", children: [row("Ada"), row("New message", { create: true })] }),
		],
	});
}

it("opens the Nth top-level sidebar row with ⌥N, skipping folded sections, nested rows and New rows", () => {
	const open = vi.fn();
	render(sidebar(open));
	press("Digit3", { altKey: true, key: "£" });
	expect(open).toHaveBeenLastCalledWith("Ada");
	press("Digit1", { altKey: true });
	expect(open).toHaveBeenLastCalledWith("sales");
	open.mockClear();
	press("Digit4", { altKey: true });
	expect(open).not.toHaveBeenCalled();
});

it("leaves ⌥N alone while typing", () => {
	const open = vi.fn();
	render(sidebar(open));
	const field = document.body.appendChild(document.createElement("input"));
	press("Digit1", { altKey: true }, field);
	const editor = document.body.appendChild(document.createElement("div"));
	editor.contentEditable = "true";
	press("Digit1", { altKey: true }, editor);
	expect(open).not.toHaveBeenCalled();
	field.remove();
	editor.remove();
});

it("shows Pin to rail, with its text, in an unpinned row's menu, including an agent with no DM yet", async () => {
	const startDm = vi.fn(async () => "chat:new" as const);
	render(h("div", null, h(Item, { label: "sales", pin: "chat:c1", onClick: () => {}, children: "sales" }), h(Item, { label: "Scout", pin: startDm, onClick: () => {}, children: "Scout" })));
	for (const name of ["sales", "Scout"]) {
		const row = [...host.querySelectorAll<HTMLElement>("[data-sidebar-item]")].find((b) => b.textContent === name)!;
		await act(async () => void row.parentElement!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
		const item = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Pin to rail");
		expect(item, name).toBeTruthy();
		await act(async () => item!.click());
	}
	expect(startDm).toHaveBeenCalledOnce();
});
