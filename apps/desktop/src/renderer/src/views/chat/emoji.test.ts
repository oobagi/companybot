import { describe, expect, it } from "vitest";
import {
	COMPLETED_SHORTCODE,
	MAX_RECENT,
	buildIndex,
	emojiForShortcode,
	loadEmoji,
	recentEmoji,
	rememberEmoji,
	savedTone,
	saveTone,
	searchEmoji,
	shortcodeMatches,
	withTone,
} from "./emoji";

const store = (initial: Record<string, string> = {}) => {
	const data = new Map(Object.entries(initial));
	return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

const tones = ["👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"].map((unicode) => ({ unicode }));
const index = buildIndex(
	[
		{ hexcode: "1F600", label: "grinning face", unicode: "😀", group: 0, order: 1, tags: ["grin", "happy"] },
		{ hexcode: "1F604", label: "grinning face with smiling eyes", unicode: "😄", group: 0, order: 2, tags: ["smile"] },
		{ hexcode: "1F642", label: "slightly smiling face", unicode: "🙂", group: 0, order: 3, tags: ["smile"] },
		{ hexcode: "1F44D", label: "thumbs up", unicode: "👍", group: 1, order: 4, tags: ["+1", "yes"], skins: tones },
		{ hexcode: "1F3FB", label: "light skin tone", unicode: "🏻", group: 2, order: 5 },
		{ hexcode: "1F1E6", label: "regional indicator A", unicode: "🇦" },
		{ hexcode: "1F3C1", label: "chequered flag", unicode: "🏁", group: 9, order: 6 },
	],
	{ "1F600": ["grinning", "smiley"], "1F604": "smile", "1F642": "slightly_smiling_face", "1F44D": ["+1", "thumbsup"], "1F3C1": "checkered_flag" },
);

describe("emoji index", () => {
	it("keeps emoji in picker order, leaving out skin-tone swatches and unplaced symbols", () => {
		expect(index.emoji.map((e) => e.char)).toEqual(["😀", "😄", "🙂", "👍", "🏁"]);
	});

	it("numbers categories without the components group", () => {
		expect(index.emoji.map((e) => e.group)).toEqual([0, 0, 0, 1, 8]);
	});

	it("looks a shortcode up, whatever its case", () => {
		expect(emojiForShortcode(index, "smile")?.char).toBe("😄");
		expect(emojiForShortcode(index, "THUMBSUP")?.char).toBe("👍");
		expect(emojiForShortcode(index, "nope")).toBeUndefined();
	});

	it("applies a skin tone only to emoji that have one", () => {
		const thumbs = emojiForShortcode(index, "+1")!;
		expect(withTone(thumbs, 0)).toBe("👍");
		expect(withTone(thumbs, 3)).toBe("👍🏽");
		expect(withTone(emojiForShortcode(index, "smile")!, 3)).toBe("😄");
	});
});

describe("emoji search", () => {
	it("ranks an exact shortcode, then a shortcode start (smiley), then name words and tags", () => {
		expect(searchEmoji(index, "smile").map((e) => e.char)).toEqual(["😄", "😀", "🙂"]);
		expect(searchEmoji(index, ":grin:").map((e) => e.char)).toEqual(["😀", "😄"]);
		expect(searchEmoji(index, "thumb").map((e) => e.char)).toEqual(["👍"]);
		expect(searchEmoji(index, "")).toEqual([]);
		expect(searchEmoji(index, "zzz")).toEqual([]);
	});

	it("offers shortcodes that start with the query first, shortest first, then later words", () => {
		expect(shortcodeMatches(index, "sm").map((m) => m.shortcode)).toEqual(["smile", "smiley", "slightly_smiling_face"]);
		expect(shortcodeMatches(index, "fac").map((m) => m.shortcode)).toEqual(["slightly_smiling_face"]);
		expect(shortcodeMatches(index, "sm", 1)).toHaveLength(1);
		expect(shortcodeMatches(index, "")).toEqual([]);
	});

	it("matches a finished :shortcode: at the end of the text, at the start or after a space", () => {
		expect(COMPLETED_SHORTCODE.exec("hi :smile:")?.[1]).toBe("smile");
		expect(COMPLETED_SHORTCODE.exec(":+1:")?.[1]).toBe("+1");
		expect(COMPLETED_SHORTCODE.test("hi :smile")).toBe(false);
		expect(COMPLETED_SHORTCODE.test("at 10:30:45")).toBe(false);
		expect(COMPLETED_SHORTCODE.test("note:smile:")).toBe(false);
	});
});

describe("recents and skin tone", () => {
	it("puts the newest first, once, up to a cap", () => {
		const s = store();
		rememberEmoji(s, "😀");
		rememberEmoji(s, "🙂");
		expect(rememberEmoji(s, "😀")).toEqual(["😀", "🙂"]);
		for (let i = 0; i < MAX_RECENT + 5; i++) rememberEmoji(s, `e${i}`);
		expect(recentEmoji(s)).toHaveLength(MAX_RECENT);
		expect(recentEmoji(s)[0]).toBe(`e${MAX_RECENT + 4}`);
	});

	it("reads nothing from damaged storage", () => {
		expect(recentEmoji(store({ "emoji.recent": "{" }))).toEqual([]);
		expect(recentEmoji(store({ "emoji.recent": '{"a":1}' }))).toEqual([]);
		expect(recentEmoji(store({ "emoji.recent": '["😀",3]' }))).toEqual(["😀"]);
	});

	it("keeps the skin tone, 0 to 5", () => {
		const s = store();
		expect(savedTone(s)).toBe(0);
		saveTone(s, 4);
		expect(savedTone(s)).toBe(4);
		expect(savedTone(store({ "emoji.tone": "9" }))).toBe(0);
	});
});

describe("the bundled data", () => {
	it("loads offline with the usual shortcodes", async () => {
		const real = await loadEmoji();
		expect(real.emoji.length).toBeGreaterThan(1500);
		expect(emojiForShortcode(real, "smile")?.char).toBe("😄");
		expect(emojiForShortcode(real, "+1")?.char).toBe("👍");
		expect(withTone(emojiForShortcode(real, "wave")!, 5)).toBe("👋🏿");
		expect(shortcodeMatches(real, "smi")[0]?.shortcode).toMatch(/^smi/);
	});
});
