import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EmojiMenu, type EmojiPick } from "./editorComponents";

it("moves across emoji columns and rows, selects with Enter, and resets selection for a new query", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const editor = BlockNoteEditor.create();
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host);
	const pick = vi.fn();
	const render = (items?: EmojiPick[]) => createElement(BlockNoteViewRaw<typeof editor.schema.blockSchema, typeof editor.schema.inlineContentSchema, typeof editor.schema.styleSchema>, {
		editor, slashMenu: false, emojiPicker: false, sideMenu: false, formattingToolbar: false, linkToolbar: false, filePanel: false, tableHandles: false,
	}, items && createElement(EmojiMenu, { items, selectedIndex: 0, loadingState: "loaded", onItemClick: pick }));
	const press = async (key: string) => { await act(async () => { editor.domElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); };
	try {
		await act(async () => root.render(render()));
		const items = Array.from({ length: 12 }, (_, index) => ({ query: "smile", char: `emoji${index}` }));
		await act(async () => root.render(render(items)));
		await press("ArrowDown"); await press("ArrowRight"); await press("Enter");
		expect(pick).toHaveBeenLastCalledWith(items[10]);
		const short = [{ query: "wave", char: "👋" }, { query: "wave", char: "✋" }];
		await act(async () => root.render(render(short)));
		await press("Enter");
		expect(pick).toHaveBeenLastCalledWith(short[0]);
		await press("ArrowUp"); await press("Enter");
		expect(pick).toHaveBeenLastCalledWith(short[1]);
	} finally {
		await act(async () => root.unmount()); editor._tiptapEditor.destroy(); host.remove();
	}
});
