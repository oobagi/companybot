import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { PopoverPanel } from "./common";

vi.mock("react-dom", async (actual) => ({ ...(await actual<typeof import("react-dom")>()), createPortal: (node: React.ReactNode) => node }));

let root: ReactTestRenderer;
afterEach(async () => {
	await act(async () => root?.unmount());
	vi.unstubAllGlobals();
});

it("moves a loading popover to the roomier side when its full result arrives", async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
	vi.stubGlobal("window", { innerHeight: 800, innerWidth: 1200, addEventListener: vi.fn(), removeEventListener: vi.fn() });
	let resize = () => {};
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: () => void) { resize = callback; }
		observe() {}
		disconnect() {}
	});
	const panel = {
		getBoundingClientRect: () => ({ width: 512 }),
		children: [], scrollHeight: 20, clientHeight: 20, offsetHeight: 22,
	};
	const anchor = { left: 100, top: 600, right: 200, bottom: 620, width: 100, height: 20 } as DOMRect;
	await act(async () => {
		root = create(createElement(PopoverPanel, { anchor, onClose() {}, children: "Loading…" }), { createNodeMock: () => panel });
	});
	const style = () => root.root.findByProps({ "data-popover": true }).props.style;
	expect(style().top).toBe(626);

	// The loaded content is much taller than the space the loading line chose below the button.
	Object.assign(panel, { scrollHeight: 1600, clientHeight: 166, offsetHeight: 168 });
	await act(async () => resize());
	expect(style()).toMatchObject({ top: 34, maxHeight: 560 });

	Object.assign(panel, { scrollHeight: 20, clientHeight: 20, offsetHeight: 22 });
	await act(async () => resize());
	expect(style().top).toBe(626);
});
