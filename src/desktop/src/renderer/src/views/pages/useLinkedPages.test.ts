import { act, createElement } from "react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { useLinkedPages } from "./useLinkedPages";

it("coalesces rapid edits into one scan and cancels pending work on unmount", async () => {
	vi.useFakeTimers();
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	let changed!: () => void;
	const unsubscribe = vi.fn();
	const scan = vi.fn((visit: (block: unknown) => void) => visit({ content: [{ type: "link", href: "companybot://page/abc123" }] }));
	const editor = { forEachBlock: scan, onChange: (callback: () => void) => { changed = callback; return unsubscribe; } } as unknown as Parameters<typeof useLinkedPages>[0];
	let linked = new Set<string>();
	function Harness() { linked = useLinkedPages(editor); return null; }
	let root!: ReturnType<typeof create>;
	try {
		await act(async () => { root = create(createElement(Harness)); });
		expect(linked.has("abc123")).toBe(true);
		for (let i = 0; i < 100; i++) changed();
		expect(scan).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTime(299));
		expect(scan).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTime(1));
		expect(scan).toHaveBeenCalledTimes(2);
		changed();
		await act(async () => root.unmount());
		vi.advanceTimersByTime(300);
		expect(scan).toHaveBeenCalledTimes(2);
		expect(unsubscribe).toHaveBeenCalledOnce();
	} finally { await act(async () => root?.unmount()); vi.useRealTimers(); }
});
