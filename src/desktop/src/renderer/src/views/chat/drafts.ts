import type { Editor, JSONContent } from "@tiptap/core";
import { useEffect, useSyncExternalStore } from "react";
import { pendingFiles, pendingKey } from "./composerFiles";
import { plainText } from "./editor";

// Drafts: what you've typed in a composer and not sent, per person, per chat and per thread. They
// stay on this computer (localStorage, like the sidebar's order), chips and all, under the person's
// id, so another account signed in here never sees them and yours are there when you switch back.
// They go when you send. A draft nobody came back to expires after a month.

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "text:";
/** Before drafts were per person they were saved under the composer's key alone; nobody's sure whose. */
const UNOWNED = "draft:";
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 400;

/** One key per composer: the workspace, the chat, and the thread if it's a thread's. Its files use it too (composerFiles.ts). */
export const draftKey = (workspaceId: string | undefined, chatId: string, threadId?: string) =>
	`${UNOWNED}${workspaceId}:${chatId}${threadId ? `:${threadId}` : ""}`;

/** Where one person's text for a composer is saved. */
export const textKey = (userId: string, draftKey: string) => `${PREFIX}${userId}:${draftKey}`;

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

const keysUnder = (store: Store, prefix: string) => {
	const keys: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const k = store.key(i);
		if (k?.startsWith(prefix)) keys.push(k);
	}
	return keys;
};

/** A workspace's composers share this start: `draft:<workspace>:`, then the chat. */
const inWorkspace = (workspaceId: string) => draftKey(workspaceId, "");
/** The chat a key under `prefix` is for, a thread's too. */
const chatOf = (prefix: string) => (key: string) => key.slice(prefix.length).split(":")[0]!;

/** The chats in this workspace where this person has a draft, in the chat or in one of its threads. */
export function chatsWithDrafts(store: Store, userId: string, workspaceId: string, now = Date.now()): Set<string> {
	const prefix = textKey(userId, inWorkspace(workspaceId));
	// Loading drops the expired ones as it goes.
	return new Set(keysUnder(store, prefix).filter((k) => loadDraft(store, k, now)).map(chatOf(prefix)));
}

/** Drops the drafts nobody owns (saved before they were per person) and the expired ones. */
export function sweepDrafts(store: Store, now = Date.now()) {
	for (const k of keysUnder(store, UNOWNED)) saveDraft(store, k, null);
	for (const k of keysUnder(store, PREFIX)) loadDraft(store, k, now);
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

/** Puts back a message that didn't send, after its composer closed, unless something new was typed there since. */
export function keepDraft(key: string, doc: JSONContent) {
	if (loadDraft(localStorage, key)) return;
	saveDraft(localStorage, key, doc);
	changed();
}

let swept = false;
const subscribeAll = (listener: () => void) => {
	// Once a run, when the sidebar first listens.
	if (!swept) {
		swept = true;
		sweepDrafts(localStorage);
	}
	const text = subscribe(listener);
	const files = pendingFiles().subscribe(listener);
	return () => (text(), files());
};

/** The ids of chats where this person has a draft or files waiting to send, for the sidebar. */
export function useDraftChats(userId: string | undefined, workspaceId: string | undefined): Set<string> {
	const snapshot = () => {
		if (!userId || !workspaceId) return "";
		const prefix = pendingKey(userId, inWorkspace(workspaceId));
		const ids = new Set([...chatsWithDrafts(localStorage, userId, workspaceId), ...pendingFiles().withFiles(prefix).map(chatOf(prefix))]);
		// A string, so React sees "same drafts" as the same value.
		return [...ids].sort().join(",");
	};
	const ids = useSyncExternalStore(subscribeAll, snapshot);
	return new Set(ids ? ids.split(",") : []);
}

/**
 * Keeps `editor` in step with the draft under `key` (`textKey`; none until the person is known, so
 * nothing is shown or saved before then): puts it back when the composer opens (or
 * moves to another chat), and saves as you type. Sending empties the editor, which forgets it.
 * `onRestored` hears whether the editor is empty after a restore, which isn't an edit.
 */
export function useDraft(editor: Editor | null, key: string | undefined, onRestored: (empty: boolean) => void) {
	useEffect(() => {
		if (!editor) return;
		if (!key) {
			// Nobody known yet (or anymore): show nobody's draft.
			editor.commands.clearContent(false);
			onRestored(true);
			return;
		}
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
