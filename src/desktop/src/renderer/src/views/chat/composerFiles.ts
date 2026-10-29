import type { Id } from "@companybot/backend/convex/_generated/dataModel";

// A composer's files waiting to be sent, kept per person and per chat or thread (the draft's key,
// drafts.ts), so switching chats, threads or workspaces and coming back finds them, and their
// uploads aren't stranded on the server until the sweep. They live in memory while the app runs;
// uploaded ones are also saved on this computer under the person's id, so they come back after a
// restart and nobody else signed in here sees them. An upload goes a day after it's made if no
// message claims it (backend images.ts `UPLOAD_TTL_MS`), so a saved one expires then too.

export type Pending = {
	key: string;
	name: string;
	size: number;
	/** A picture's object URL, this session only. */
	preview?: string;
	progress: number;
	file?: Id<"_storage">;
	/** When the upload finished, for expiry. */
	at?: number;
	error?: string;
};

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "files:";
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** One list per person per composer. */
export const pendingKey = (userId: string, draftKey: string) => `${PREFIX}${userId}:${draftKey}`;

type Saved = { file: string; name: string; size: number; at: number };
const isSaved = (f: unknown): f is Saved => {
	const s = f as Saved;
	return !!s && typeof s.file === "string" && typeof s.name === "string" && typeof s.size === "number" && typeof s.at === "number";
};

/** Saves the uploaded ones in `items`, or forgets the key when there are none. */
export function savePending(store: Store, key: string, items: Pending[]) {
	const saved: Saved[] = items.flatMap((i) => (i.file && i.at && !i.error ? [{ file: i.file, name: i.name, size: i.size, at: i.at }] : []));
	try {
		if (saved.length) store.setItem(key, JSON.stringify(saved));
		else store.removeItem(key);
	} catch {
		// Storage may be full or unavailable; they're kept for this session only.
	}
}

/** The saved files under `key` whose uploads are still waiting. Expired or unreadable ones are dropped. */
export function loadPending(store: Store, key: string, now = Date.now()): Pending[] {
	let saved: Saved[] = [];
	try {
		const raw = store.getItem(key);
		if (raw === null) return [];
		const list: unknown = JSON.parse(raw);
		if (Array.isArray(list)) saved = list.filter(isSaved);
	} catch {
		// Unreadable is the same as none.
	}
	const items = saved
		.filter((s) => now - s.at < PENDING_TTL_MS)
		.map((s) => ({ key: crypto.randomUUID(), name: s.name, size: s.size, progress: 1, file: s.file as Id<"_storage">, at: s.at }));
	savePending(store, key, items);
	return items;
}

const NONE: Pending[] = [];

/** Every composer's pending files: read with `get`, change with `update`, hear changes with `subscribe`. */
export function createPendingStore(store: Store, now = Date.now) {
	const lists = new Map<string, Pending[]>();
	const listeners = new Set<() => void>();
	// Saved lists nobody opens again would stay forever: drop the expired ones once, at start.
	const keys: string[] = [];
	for (let i = 0; i < store.length; i++) {
		const k = store.key(i);
		if (k?.startsWith(PREFIX)) keys.push(k);
	}
	for (const k of keys) loadPending(store, k, now());

	const get = (key: string | undefined): Pending[] => {
		if (!key) return NONE;
		let list = lists.get(key);
		if (!list) lists.set(key, (list = loadPending(store, key, now())));
		return list;
	};
	return {
		get,
		update(key: string, change: (list: Pending[]) => Pending[]) {
			const list = change(get(key));
			lists.set(key, list);
			savePending(store, key, list);
			listeners.forEach((l) => l());
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		/** The keys under `prefix` with files in them, uploaded or not, saved or only in memory. */
		withFiles(prefix: string): string[] {
			const saved: string[] = [];
			for (let i = 0; i < store.length; i++) {
				const k = store.key(i);
				if (k?.startsWith(prefix) && !lists.has(k)) saved.push(k);
			}
			return [...lists.keys(), ...saved].filter((k) => k.startsWith(prefix) && get(k).length);
		},
	};
}

let shared: ReturnType<typeof createPendingStore> | undefined;
/** The app's one store. Made on first use: there's no localStorage where tests import this. */
export const pendingFiles = () => (shared ??= createPendingStore(localStorage));

type Clipboard = { types: readonly string[]; files: ArrayLike<File>; getData: (format: string) => string };

/**
 * The files a paste attaches. Excel, Word and Keynote put a picture of what was copied next to its
 * text and HTML: that's a text paste, so none. Finder puts the files' names as text but no HTML,
 * and a copied picture or screenshot has no text, so those attach.
 */
export function pastedFiles(clipboard: Clipboard): File[] {
	const textWithPicture = clipboard.types.includes("text/html") && clipboard.getData("text/plain").trim() !== "";
	return textWithPicture ? [] : Array.from(clipboard.files);
}
