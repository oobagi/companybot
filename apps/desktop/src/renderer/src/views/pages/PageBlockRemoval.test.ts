import { act, createContext, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Confirm } from "../chat/common";
import { PageReferences, type PageBlockEditor, type PageReference } from "./PageBlock";
import { PageBlockRemoval } from "./PageBlockRemoval";

const archive = vi.hoisted(() => vi.fn());
vi.mock("../../convex", () => ({ useMutation: () => archive }));
vi.mock("./PageBlock", () => ({ PageReferences: createContext(null) }));
vi.mock("react-dom", async (actual) => ({ ...(await actual<typeof import("react-dom")>()), createPortal: (node: React.ReactNode) => node }));

let root: ReactTestRenderer;
let before: Parameters<PageBlockEditor["onBeforeChange"]>[0];
const remove = vi.fn();
const references = new Map<string, PageReference>();
const editor = {
	onBeforeChange: (callback: typeof before) => { before = callback; return () => {}; },
	getBlock: () => ({ id: "block1" }),
	removeBlocks: remove,
} as unknown as PageBlockEditor;

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
	archive.mockReset().mockResolvedValue(undefined);
	remove.mockReset();
	references.clear();
	references.set("child", { _id: "child", title: "Guide", parentId: "parent", archived: false } as unknown as PageReference);
	await act(async () => { root = create(createElement(PageReferences.Provider, { value: references }, createElement(PageBlockRemoval, { editor, pageId: "parent", editable: true }))); });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

const attempt = (remote = false) => before({
	getChanges: () => [{ type: "delete", source: { type: "local" }, prevBlock: undefined, block: { id: "block1", type: "page", props: { pageId: "child", title: "Old title" }, children: [] } }],
	tr: { getMeta: (key: string) => key === "addToHistory" && remote ? false : undefined },
} as unknown as Parameters<typeof before>[0]);

it("blocks keyboard/menu removal until confirmed, using the page's current title", async () => {
	await act(async () => { expect(attempt()).toBe(false); });
	expect(archive).not.toHaveBeenCalled();
	expect(remove).not.toHaveBeenCalled();
	expect(root.root.findByType(Confirm).props).toMatchObject({ title: "Archive “Guide”?", danger: false });
	await act(async () => root.root.findByType(Confirm).props.onClose());
	expect(remove).not.toHaveBeenCalled();
	await act(async () => { attempt(); });
	await act(async () => root.root.findByType(Confirm).props.onConfirm());
	expect(archive).toHaveBeenCalledExactlyOnceWith({ kind: "page", id: "child" });
	expect(remove).toHaveBeenCalledWith(["block1"]);
});

it.each([null, { _id: "child", title: "Guide", parentId: "another-parent", archived: false }])("removes a missing or external page reference without archiving its target", async (page) => {
	references.set("child", page as PageReference);
	await act(async () => { attempt(); });
	expect(root.root.findByType(Confirm).props.action).toBe("Remove block");
	await act(async () => root.root.findByType(Confirm).props.onConfirm());
	expect(archive).not.toHaveBeenCalled();
	expect(remove).toHaveBeenCalledWith(["block1"]);
});

it("lets authorized server changes synchronize without asking again", async () => {
	await act(async () => { expect(attempt(true)).toBeUndefined(); });
	expect(root.toJSON()).toBeNull();
	expect(archive).not.toHaveBeenCalled();
});
