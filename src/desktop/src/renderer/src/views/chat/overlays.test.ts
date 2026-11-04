// Popovers and dialogs on Mantine, on a real (stand-in) page: they stack, and Escape or a click
// outside closes only the newest, giving focus back to what opened it.
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { inApp } from "../../testing";
import { Confirm, MenuItem, Modal, Popover } from "./common";

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

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const host = document.body.appendChild(document.createElement("div"));
	await act(async () => (root = createRoot(host)).render(inApp(h(Screen))));
	button("Open dialog").focus();
	await click(button("Open dialog"));
});
afterEach(async () => {
	await act(async () => root.unmount());
	document.body.innerHTML = "";
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
