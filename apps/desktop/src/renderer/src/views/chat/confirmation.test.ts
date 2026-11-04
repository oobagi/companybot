import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Confirm, archiveQuestion, useConfirm } from "./common";

vi.mock("react-dom", async (actual) => ({ ...(await actual<typeof import("react-dom")>()), createPortal: (node: React.ReactNode) => node }));
let root: ReactTestRenderer;
let control: ReturnType<typeof useConfirm>;
function Harness() { control = useConfirm(); return control.dialog; }

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
	await act(async () => { root = create(createElement(Harness)); });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it("asks neutrally before archiving, preserves content on Cancel, and runs only after confirmation", async () => {
	const archive = vi.fn().mockResolvedValue(undefined);
	await act(async () => control.confirm(archiveQuestion("Guide", archive)));
	expect(archive).not.toHaveBeenCalled();
	expect(root.root.findByType(Confirm).props).toMatchObject({ danger: false, action: "Archive" });
	expect(JSON.stringify(root.toJSON())).toContain("Nothing is permanently deleted");
	await act(async () => root.root.findByType(Confirm).props.onClose());
	expect(archive).not.toHaveBeenCalled();
	expect(root.toJSON()).toBeNull();
	await act(async () => control.confirm(archiveQuestion("Guide", archive)));
	await act(async () => root.root.findByType(Confirm).props.onConfirm());
	expect(archive).toHaveBeenCalledOnce();
	expect(root.toJSON()).toBeNull();
});

it("prevents double submission and keeps a failed confirmation open for retry", async () => {
	let reject!: (reason: unknown) => void;
	const remove = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
	await act(async () => control.confirm({ title: "Delete forever?", action: "Delete forever", onConfirm: remove }));
	const confirm = root.root.findByType(Confirm).props.onConfirm;
	await act(async () => { confirm(); confirm(); });
	expect(remove).toHaveBeenCalledOnce();
	expect(root.root.findByType(Confirm).props).toMatchObject({ danger: true, busy: true });
	await act(async () => root.root.findByType(Confirm).props.onClose());
	expect(root.root.findByType(Confirm)).toBeTruthy();
	await act(async () => reject(new Error("Try again")));
	expect(root.root.findByType(Confirm).props).toMatchObject({ error: "Try again", busy: false });
});
