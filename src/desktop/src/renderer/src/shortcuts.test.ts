// Number shortcuts: ⌘N opens the Nth rail tab in the order shown, ⌥N the Nth sidebar row, not while
// typing; the old G-then-a-letter keys do nothing. Also: an unpinned row's menu offers Pin to rail.
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inApp } from "./testing";
import { AppRail } from "./views/AppRail";
import type { AppTab } from "./views/RailPins";
import { Modal } from "./views/chat/common";
import { Group, Item, SidebarList } from "./views/chat/Sidebar";

const saved = vi.hoisted(() => ({ rail: [] as string[], pins: [] as string[] }));
vi.mock("./arrangements", () => ({ useStoredIds: (list: string) => [list === "rail" ? saved.rail : [], () => {}, true] }));
// The rail resolves pins from these; with none pinned it needs nothing back.
vi.mock("./convex", async (real) => ({ ...(await real<typeof import("./convex")>()), useQuery: () => undefined, useWorkspace: () => undefined }));
vi.mock("./views/records/data", () => ({ useTypes: () => [] }));
vi.mock("./pins", async (real) => ({ ...(await real<typeof import("./pins")>()), usePins: () => ({ pins: saved.pins, recent: [], toggle: vi.fn(), visit: vi.fn(), canSaveRecent: true }) }));

let root: Root;
let host: HTMLElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", configurable: true });
	saved.rail = [];
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

	saved.rail = ["customize", "databases"];
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
	press("Digit2", { metaKey: true }, composer);
	expect(onOpen).toHaveBeenCalledWith("drive");
	composer.remove();
});

it("does nothing while a dialog or menu is open, so a half-filled form isn't lost", () => {
	const onOpen = vi.fn();
	const open = vi.fn();
	render(h("div", null, rail(onOpen), sidebar(open), h(Modal, { title: "New channel", onClose: () => {}, children: h("input", { "aria-label": "Name" }) })));
	press("Digit2", { metaKey: true });
	press("Digit1", { metaKey: true, ctrlKey: true });
	press("Digit1", { altKey: true });
	expect(onOpen).not.toHaveBeenCalled();
	expect(open).not.toHaveBeenCalled();
	// Closed, they work again.
	render(h("div", null, rail(onOpen)));
	press("Digit2", { metaKey: true });
	expect(onOpen).toHaveBeenCalledWith("drive");
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

it("opens sidebar rows while typing", () => {
	const open = vi.fn();
	render(sidebar(open));
	const field = document.body.appendChild(document.createElement("input"));
	press("Digit1", { altKey: true }, field);
	const editor = document.body.appendChild(document.createElement("div"));
	editor.contentEditable = "true";
	press("Digit1", { altKey: true }, editor);
	expect(open).toHaveBeenCalledWith("sales");
	expect(open).toHaveBeenCalledTimes(2);
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

it("saves an active edit before keyboard navigation", () => {
	const events: string[] = [];
	render(rail(() => events.push("navigate")));
	const input = document.body.appendChild(document.createElement("input"));
	input.addEventListener("blur", () => events.push("save"));
	input.focus();
	press("Digit2", { metaKey: true }, input);
	expect(events).toEqual(["save", "navigate"]);
	input.remove();
});

it.each(["@", "#", "[", "]", "|", "{", "}"])("preserves printable ASCII %s while typing", (key) => {
	const open = vi.fn();
	render(sidebar(open));
	const input = document.body.appendChild(document.createElement("input"));
	input.focus();
	const event = new KeyboardEvent("keydown", { code: "Digit2", key, altKey: true, bubbles: true, cancelable: true });
	act(() => { input.dispatchEvent(event); });
	expect(event.defaultPrevented).toBe(false);
	expect(document.activeElement).toBe(input);
	expect(open).not.toHaveBeenCalled();
	input.remove();
});

it("leaves composing keys and missing sidebar rows alone", () => {
	const open = vi.fn();
	render(sidebar(open));
	for (const options of [{ code: "Digit1", isComposing: true }, { code: "Digit9" }]) {
		const event = new KeyboardEvent("keydown", { ...options, key: "™", altKey: true, bubbles: true, cancelable: true });
		act(() => { document.body.dispatchEvent(event); });
		expect(event.defaultPrevented).toBe(false);
	}
	expect(open).not.toHaveBeenCalled();
});

it("keeps focus for missing and already open tabs", () => {
	render(rail(vi.fn()));
	const input = document.body.appendChild(document.createElement("input"));
	input.focus();
	press("Digit7", { metaKey: true }, input);
	expect(document.activeElement).toBe(input);
	press("Digit1", { metaKey: true }, input);
	expect(document.activeElement).toBe(input);
	input.remove();
});

it("saves an edit before a rail click navigates", () => {
	const events: string[] = [];
	render(rail(() => events.push("navigate")));
	const input = document.body.appendChild(document.createElement("input"));
	input.addEventListener("blur", () => events.push("save"));
	input.focus();
	act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Drive"]')!.click(); });
	expect(events).toEqual(["save", "navigate"]);
	input.remove();
});
