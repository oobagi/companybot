import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { BlockNoteEditor, docToBlocks } from "@blocknote/core";
import { BlockNoteView, type Theme, lightDefaultTheme } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import { useMemo, useState } from "react";
import { api, errorMessage } from "../../api";
import { Loading, Notice } from "../../ui";

// A page's content: BlockNote, synced live through prosemirror-sync (backend pageSync.ts).
// The sync calls name only the page; the backend finds its workspace. See wiki/pages.md.

/** BlockNote's own light theme, in the app's font. */
const theme: Theme = { ...lightDefaultTheme, fontFamily: "inherit" };

/** BlockNote pads the left for its block handles: pull it back so text lines up with the title. */
const viewClass = "-mx-[54px]";

export function PageEditor({ pageId, editable }: { pageId: Id<"pages">; editable: boolean }) {
	const [error, setError] = useState<string>();
	const sync = useBlockNoteSync<BlockNoteEditor>(api.pageSync, pageId, { onSyncError: (e) => setError(errorMessage(e)) });
	if (sync.isLoading) return <Loading />;
	if (!sync.editor) return <Notice>This page isn't available.</Notice>;
	return (
		<>
			{error && <Notice>{error}</Notice>}
			<BlockNoteView editor={sync.editor} editable={editable} theme={theme} className={viewClass} />
		</>
	);
}

let schemaEditor: BlockNoteEditor | undefined;

/** An old version's content (ProseMirror JSON), read-only. */
export function VersionPreview({ content }: { content: string }) {
	const editor = useMemo(() => {
		schemaEditor ??= BlockNoteEditor.create();
		const doc = schemaEditor.pmSchema.nodeFromJSON(JSON.parse(content));
		return BlockNoteEditor.create({ initialContent: docToBlocks(doc) });
	}, [content]);
	return <BlockNoteView editor={editor} editable={false} theme={theme} className={viewClass} />;
}
