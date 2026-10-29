import type { Editor, JSONContent } from "@tiptap/core";
import { useEffect, useSyncExternalStore } from "react";
import { plainText } from "./editor";

// Drafts: what you've typed in a composer and not sent, per chat and per thread. They stay on
// this computer (localStorage, like the sidebar's order), chips and all, and go when you send.
// A draft nobody came back to expires after a month.

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "draft:";
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 400;

/** One key per composer: the workspace, the chat, and the thread if it's a thread's. */
export const draftKey = (workspaceId: string | undefined, chatId: string, threadId?: string) =>
	`${PREFIX}${workspaceId}:${chatId}${threadId ? `:${threadId}` : ""}`;

const isDoc = (doc: unknown): doc is JSONContent => !!doc && typeof doc === "object" && (doc as JSONContent).type === "doc" && Array.isArray((doc as JSONContent).content);

/** Saves `doc`, or forgets the draft when there is none. */
export function saveDraft(store: Store, key: string, doc: JSONContent | null, now = Date.now()) {
	try {
		if (doc) store.setItem(key, JSON.stringify({ doc, at: now }));
		else store.removeItem(key);
	} catch {
		// Storage may be full or unavailable; the draft just isn't kept.
	}
}

/** The saved draft, or null if there is none, it's too old, or it's unreadable (those are dropped). */
export function loadDraft(store: Store, key: string, now = Date.now()): JSONContent | null {
	try {
		const raw = store.getItem(key);
		if (raw === null) return null;
		const saved = JSON.parse(raw);
		if (isDoc(saved?.doc) && typeof saved.at === "number" && now - saved.at < DRAFT_TTL_MS) return saved.doc;
	} catch {
		// Unreadable is the same as too old.
	}
	saveDraft(store, key, null);
	return null;
}

/** The chats in this workspace with a draft in them, in the chat or in one of its threads. */
export function chatsWithDrafts(store: Store, workspaceId: string, now = Date.now()): Set<string> {
	const prefix = `${PREFIX}${workspaceId}:`;
	const keys: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const k = store.key(i);
		if (k?.startsWith(prefix)) keys.push(k);
	}
	// Loading drops the expired ones as it goes.
	return new Set(keys.filter((k) => loadDraft(store, k, now)).map((k) => k.slice(prefix.length).split(":")[0]!));
}

// The sidebar shows which chats have drafts, so it hears about each change.
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	window.addEventListener("storage", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", listener);
	};
};

/** The ids of chats with a draft, for the sidebar. */
export function useDraftChats(workspaceId: string | undefined): Set<string> {
	// A string, so React sees "same drafts" as the same value.
	const ids = useSyncExternalStore(subscribe, () => (workspaceId ? [...chatsWithDrafts(localStorage, workspaceId)].sort().join(",") : ""));
	return new Set(ids ? ids.split(",") : []);
}

/**
 * Keeps `editor` in step with the draft under `key`: puts it back when the composer opens (or
 * moves to another chat), and saves as you type. Sending empties the editor, which forgets it.
 * `onRestored` hears whether the editor is empty after a restore, which isn't an edit.
 */
export function useDraft(editor: Editor | null, key: string | undefined, onRestored: (empty: boolean) => void) {
	useEffect(() => {
		if (!editor || !key) return;
		const saved = loadDraft(localStorage, key);
		try {
			// Not an edit: no "typing…" ping.
			if (saved) editor.commands.setContent(saved, { emitUpdate: false });
			else editor.commands.clearContent(false);
		} catch {
			saveDraft(localStorage, key, null);
			editor.commands.clearContent(false);
		}
		onRestored(editor.isEmpty);
		if (saved) editor.commands.focus("end");

		let timer: ReturnType<typeof setTimeout> | undefined;
		const save = () => {
			clearTimeout(timer);
			timer = undefined;
			saveDraft(localStorage, key, plainText(editor) ? editor.getJSON() : null);
			changed();
		};
		const edited = () => {
			clearTimeout(timer);
			timer = setTimeout(save, SAVE_DELAY_MS);
		};
		const flush = () => timer && save();
		editor.on("update", edited);
		window.addEventListener("pagehide", flush);
		return () => {
			editor.off("update", edited);
			window.removeEventListener("pagehide", flush);
			flush();
		};
	}, [editor, key, onRestored]);
}
