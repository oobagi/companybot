// Popovers and dialogs on Mantine, on a real (stand-in) page: they stack, and Escape or a click
// outside closes only the newest, giving focus back to what opened it.
import { act, createElement as h, type ReactNode, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inApp } from "../../testing";
import { Confirm, MenuItem, Modal, Popover, PopoverPanel } from "./common";

let root: Root;
const settle = () => act(async () => await new Promise((done) => setTimeout(done, 20)));
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name)!;
const shown = (text: string) => document.body.textContent!.includes(text);
const press = async (key: string) => {
	await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
	await settle();
};
const click = async (el: Element) => {
	await act(async () => void el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
	await act(async () => (el as HTMLElement).click());
	await settle();
};

/** A button that opens a dialog holding a menu, whose item asks a question over the dialog. */
function Screen() {
	const [open, setOpen] = useState(false);
	const [asking, setAsking] = useState(false);
	const menu = (close: () => void) => h(MenuItem, { onClick: () => (close(), setAsking(true)), children: "Delete" });
	const dialog = h(Modal, {
		title: "Details",
		onClose: () => setOpen(false),
		children: [
			h("input", { key: "name", "aria-label": "Name" }),
			h(Popover, { key: "menu", trigger: "Menu", children: menu }),
			h(Popover, { key: "outer", trigger: "Outer", children: h(Popover, { trigger: "Inner", children: "Inner panel" }) }),
			asking && h(Confirm, { key: "confirm", title: "Delete it?", action: "Delete", onConfirm: () => {}, onClose: () => setAsking(false) }),
		],
	});
	return h("div", null, h("button", { type: "button", onClick: () => setOpen(true) }, "Open dialog"), open && dialog);
}

async function mount(node: ReactNode) {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const host = document.body.appendChild(document.createElement("div"));
	await act(async () => (root = createRoot(host)).render(inApp(node)));
}
/** Like a click in Chromium, which focuses the button as you press it. */
const press_ = async (el: HTMLElement) => (el.focus(), await click(el));
afterEach(async () => {
	await act(async () => root.unmount());
	document.body.innerHTML = "";
	for (const key of ["clientWidth", "clientHeight"]) delete (document.documentElement as unknown as Record<string, unknown>)[key];
});

describe("a menu, popovers and a Confirm in a dialog", () => {
beforeEach(async () => {
	await mount(h(Screen));
	await press_(button("Open dialog"));
});

it("takes focus into a dialog and gives it back to what opened it", async () => {
	expect(document.activeElement?.closest('[role="dialog"]')?.textContent).toContain("Details");
	await press("Escape");
	expect(shown("Details")).toBe(false);
	expect(document.activeElement).toBe(button("Open dialog"));
});

it("closes only a menu inside a dialog on Escape, focusing its button, then the dialog", async () => {
	await click(button("Menu"));
	expect(shown("Delete")).toBe(true);
	expect(document.activeElement?.textContent).toBe("Delete");
	await press("Escape");
	expect(shown("Delete")).toBe(false);
	expect(shown("Details")).toBe(true);
	expect(document.activeElement).toBe(button("Menu"));
	await press("Escape");
	expect(shown("Details")).toBe(false);
});

it("closes only the newest layer on a click outside", async () => {
	await click(button("Menu"));
	// On the dialog's dimmed backdrop: the menu goes, the dialog stays.
	await click(document.querySelector(".bg-neutral-900\\/20")!);
	expect(shown("Delete")).toBe(false);
	expect(shown("Details")).toBe(true);
	await click(document.querySelector(".bg-neutral-900\\/20")!);
	expect(shown("Details")).toBe(false);
});

it("keeps a popover open while you use one opened from it, and closes them newest first", async () => {
	await click(button("Outer"));
	await click(button("Inner"));
	await click([...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent === "Inner panel")!);
	expect(shown("Inner panel")).toBe(true);
	await click(document.querySelector('input[aria-label="Name"]')!);
	expect(shown("Inner panel")).toBe(false);
	expect(button("Inner")).toBeTruthy();
	await press("Escape");
	expect(button("Inner")).toBeUndefined();
	expect(shown("Details")).toBe(true);
});

it("stacks a Confirm asked from a menu over the dialog; Escape closes just the Confirm", async () => {
	await click(button("Menu"));
	await click(button("Delete"));
	expect(shown("Delete it?")).toBe(true);
	// Cancel takes focus as it opens (autoFocus), not the first button.
	expect(document.activeElement).toBe(button("Cancel"));
	await press("Escape");
	expect(shown("Delete it?")).toBe(false);
	expect(shown("Details")).toBe(true);
});
});

describe("layers side by side", () => {
	it("closes the newer of two dialogs on Escape, not both", async () => {
		function Two() {
			const [a, setA] = useState(false);
			const [b, setB] = useState(false);
			return h(
				"div",
				null,
				h("button", { type: "button", onClick: () => setA(true) }, "Open A"),
				h("button", { type: "button", onClick: () => setB(true) }, "Open B"),
				a && h(Modal, { title: "Dialog A", onClose: () => setA(false), children: null }),
				b && h(Modal, { title: "Dialog B", onClose: () => setB(false), children: null }),
			);
		}
		await mount(h(Two));
		await click(button("Open A"));
		await click(button("Open B"));
		await press("Escape");
		expect([shown("Dialog A"), shown("Dialog B")]).toEqual([true, false]);
		await press("Escape");
		expect(shown("Dialog A")).toBe(false);
	});

	it("closes a hover panel opened over the emoji picker, and leaves the picker", async () => {
		function Composer() {
			const [working, setWorking] = useState(false);
			return h(
				"div",
				null,
				h(Popover, { trigger: "Emoji", children: "Emoji panel" }),
				// Opens on hover: no click, so nothing else closes.
				h(PopoverPanel, { opened: working, onClose: () => setWorking(false), trapFocus: false, target: h("button", { type: "button", onClick: () => setWorking(true) }, "2 agents working"), children: "Agents panel" }),
			);
		}
		await mount(h(Composer));
		await press_(button("Emoji"));
		await act(async () => button("2 agents working").click());
		await press("Escape");
		expect([shown("Emoji panel"), shown("Agents panel")]).toEqual([true, false]);
		await press("Escape");
		expect(shown("Emoji panel")).toBe(false);
	});
});

describe("focus after a menu", () => {
	it("goes back to the row you right-clicked, on Escape or a pick", async () => {
		function Row() {
			const [at, setAt] = useState<{ x: number; y: number }>();
			const row = useRef<HTMLButtonElement>(null);
			return h(
				"div",
				{ style: { position: "relative" }, onContextMenu: (e: React.MouseEvent) => (e.preventDefault(), setAt({ x: e.clientX, y: e.clientY })) },
				h("button", { ref: row, type: "button" }, "Row"),
				at && h(PopoverPanel, { opened: true, at, returnFocus: row, onClose: () => setAt(undefined), children: h(MenuItem, { onClick: () => setAt(undefined), children: "Pin" }) }),
			);
		}
		await mount(h(Row));
		const rightClick = async () => {
			await act(async () => void button("Row").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
			await settle();
			expect(document.activeElement).toBe(button("Pin"));
		};
		await rightClick();
		await press("Escape");
		expect(shown("Pin")).toBe(false);
		expect(document.activeElement).toBe(button("Row"));
		await rightClick();
		await click(button("Pin"));
		expect(document.activeElement).toBe(button("Row"));
	});

	it("goes back to the menu's button after a dialog its item opened closes", async () => {
		function Actions() {
			const [renaming, setRenaming] = useState(false);
			return h(
				"div",
				null,
				h(Popover, { trigger: "Actions", children: (close: () => void) => h(MenuItem, { onClick: () => (close(), setRenaming(true)), children: "Rename" }) }),
				renaming && h(Modal, { title: "Rename it", onClose: () => setRenaming(false), children: h("input", { "aria-label": "New name" }) }),
			);
		}
		await mount(h(Actions));
		await press_(button("Actions"));
		await click(button("Rename"));
		expect(document.activeElement?.closest('[role="dialog"]')?.textContent).toContain("Rename it");
		await press("Escape");
		expect(shown("Rename it")).toBe(false);
		expect(document.activeElement).toBe(button("Actions"));
	});
});

describe("a popover whose button scrolls away", () => {
	it("closes, so it stops holding focus and Tab", async () => {
		// The stand-in page has no size of its own; give it a window's.
		for (const [key, value] of [["clientWidth", 1200], ["clientHeight", 800]] as const) Object.defineProperty(document.documentElement, key, { value, configurable: true });
		await mount(h(Popover, { trigger: "Pick", children: h("button", { type: "button" }, "Option") }));
		let top = 100;
		button("Pick").getBoundingClientRect = () => DOMRect.fromRect({ x: 10, y: top, width: 80, height: 20 });
		await press_(button("Pick"));
		expect(document.activeElement).toBe(button("Option"));
		top = -500;
		await act(async () => void window.dispatchEvent(new Event("scroll")));
		await settle();
		expect(button("Option")).toBeUndefined();
	});
});
