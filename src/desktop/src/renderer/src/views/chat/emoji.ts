// Emoji for the picker, the composer's `:shortcode:` menu and reactions. The data is emojibase
// (MIT), bundled so it works offline, and loaded on first use: it's a separate chunk, ~600 KB
// of JSON that never costs the app's start. Everything here is pure except `loadEmoji`.

export interface Emoji {
	char: string;
	name: string;
	/** Index into `groups`. */
	group: number;
	tags: string[];
	/** GitHub's names (`smile`, `+1`), without the colons. */
	shortcodes: string[];
	/** The five skin-tone versions, light to dark; empty when the emoji has none (or only mixed-tone ones). */
	tones: string[];
}

export interface EmojiIndex {
	emoji: Emoji[];
	byShortcode: Map<string, Emoji>;
}

/** The categories, in the order they show (emojibase's own groups, minus "components"). */
export const groups = ["Smileys & emotion", "People & body", "Animals & nature", "Food & drink", "Travel & places", "Activities", "Objects", "Symbols", "Flags"];
/** One emoji standing for each category, on its tab. */
export const groupIcons = ["😀", "👋", "🐻", "🍔", "✈️", "⚽", "💡", "❤️", "🏁"];

/** The slice of emojibase's compact data we read. */
interface CompactEmoji {
	hexcode: string;
	label: string;
	unicode: string;
	/** emojibase's group number: 0-9, where 2 is skin-tone swatches and hair parts. */
	group?: number;
	order?: number;
	tags?: string[];
	skins?: { unicode: string }[];
}
type Shortcodes = Record<string, string | string[]>;

/** emojibase numbers 10 groups; ours leaves out 2 (components), so 3 and up shift down. */
const groupOf = (n: number) => (n > 2 ? n - 1 : n);

export function buildIndex(compact: CompactEmoji[], shortcodes: Shortcodes): EmojiIndex {
	const emoji = compact
		.filter((e) => e.group !== undefined && e.group !== 2)
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
		.map<Emoji>((e) => ({
			char: e.unicode,
			name: e.label,
			group: groupOf(e.group!),
			tags: e.tags ?? [],
			shortcodes: [shortcodes[e.hexcode] ?? []].flat(),
			tones: e.skins?.length === 5 ? e.skins.map((s) => s.unicode) : [],
		}));
	const byShortcode = new Map<string, Emoji>();
	for (const e of emoji) for (const code of e.shortcodes) if (!byShortcode.has(code)) byShortcode.set(code, e);
	return { emoji, byShortcode };
}

let loading: Promise<EmojiIndex> | undefined;
let loaded: EmojiIndex | undefined;

/** The index, fetched once. */
export function loadEmoji(): Promise<EmojiIndex> {
	loading ??= Promise.all([import("emojibase-data/en/compact.json"), import("emojibase-data/en/shortcodes/github.json")]).then(([compact, codes]) => {
		loaded = buildIndex(compact.default as unknown as CompactEmoji[], codes.default as Shortcodes);
		return loaded;
	});
	// A failed load is tried again next time.
	loading.catch(() => (loading = undefined));
	return loading;
}

/** The index if it's loaded already, for places that can't wait (typing a completed `:smile:`). */
export const loadedEmoji = () => loaded;

/** The emoji in skin tone `tone` (1 light … 5 dark; 0 is the default yellow). */
export const withTone = (e: Emoji, tone: number) => (tone > 0 && e.tones[tone - 1]) || e.char;

const words = (s: string) => s.toLowerCase().split(/[\s_:,-]+/).filter(Boolean);

/**
 * Emoji for what's typed in the picker's search: best first. A shortcode that is the query
 * outranks one that starts with it, then a word of the name, then a tag.
 */
export function searchEmoji(index: EmojiIndex, query: string, limit = 200): Emoji[] {
	const q = query.trim().toLowerCase().replace(/^:|:$/g, "");
	if (!q) return [];
	const scored: { e: Emoji; score: number }[] = [];
	for (const e of index.emoji) {
		let score = 0;
		if (e.shortcodes.includes(q)) score = 5;
		else if (e.shortcodes.some((c) => c.startsWith(q))) score = 4;
		else if (words(e.name).some((w) => w.startsWith(q))) score = 3;
		else if (e.tags.some((t) => t.toLowerCase().startsWith(q))) score = 2;
		else if (e.name.toLowerCase().includes(q)) score = 1;
		if (score) scored.push({ e, score });
	}
	// Array.sort is stable, so equal scores keep the picker's order.
	return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.e);
}

/** A row in the `:shortcode:` menu. */
export interface ShortcodeMatch {
	shortcode: string;
	emoji: Emoji;
}

/** What `:smi` offers: shortcodes starting with it first (shortest first), then ones with a later word that does (`face_smile`). */
export function shortcodeMatches(index: EmojiIndex, query: string, limit = 8): ShortcodeMatch[] {
	const q = query.toLowerCase();
	if (!q) return [];
	const starts: ShortcodeMatch[] = [];
	const inside: ShortcodeMatch[] = [];
	for (const e of index.emoji) {
		for (const shortcode of e.shortcodes) {
			if (shortcode.startsWith(q)) starts.push({ shortcode, emoji: e });
			else if (shortcode.split("_").some((w) => w.startsWith(q))) inside.push({ shortcode, emoji: e });
		}
	}
	starts.sort((a, b) => a.shortcode.length - b.shortcode.length);
	return [...starts, ...inside].slice(0, limit);
}

/** The emoji for a finished `:name:`, or undefined if there is none. */
export const emojiForShortcode = (index: EmojiIndex, name: string) => index.byShortcode.get(name.toLowerCase());

/** A `:name:` just completed at the end of the text, at the start or after a space. */
export const COMPLETED_SHORTCODE = /(?:^|\s):([a-z0-9_+-]+):$/i;

// Recents and the skin tone stay on this computer, like the sidebar's order.

type Store = Pick<Storage, "getItem" | "setItem">;
export const RECENT_KEY = "emoji.recent";
export const TONE_KEY = "emoji.tone";
export const MAX_RECENT = 24;

export function recentEmoji(store: Store): string[] {
	try {
		const saved = JSON.parse(store.getItem(RECENT_KEY) ?? "[]");
		return Array.isArray(saved) ? saved.filter((s): s is string => typeof s === "string").slice(0, MAX_RECENT) : [];
	} catch {
		return [];
	}
}

/** Puts `char` first in the recents (once) and returns them. */
export function rememberEmoji(store: Store, char: string): string[] {
	const next = [char, ...recentEmoji(store).filter((c) => c !== char)].slice(0, MAX_RECENT);
	try {
		store.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// Storage may be unavailable; the picker still works.
	}
	return next;
}

export function savedTone(store: Store): number {
	const n = Number(store.getItem(TONE_KEY));
	return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
}

export function saveTone(store: Store, tone: number) {
	try {
		store.setItem(TONE_KEY, String(tone));
	} catch {
		// As above.
	}
}
