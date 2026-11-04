import { describe, expect, it } from "vitest";
import { emojiOf, isEmoji } from "./chat";

describe("isEmoji", () => {
	it("takes any one emoji: skin tones, ZWJ sequences, flags, keycaps", () => {
		for (const emoji of ["🦄", "❤️", "❤", "👍🏽", "👨‍👩‍👧‍👦", "🧑🏻‍💻", "🏳️‍🌈", "🇯🇵", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "1️⃣", "#️⃣"]) expect(isEmoji(emoji), emoji).toBe(true);
	});

	it("refuses text, two emoji, half a flag, and nothing", () => {
		for (const s of ["", " ", "ok", "thumbs up", ":+1:", "1", "👍👍", "👍 ", "a👍", "🇯", "\u200D", null, 1]) expect(isEmoji(s), String(s)).toBe(false);
	});

	it("gives each emoji one form, the picker's, so one reaction is never two", () => {
		const forms = [["❤", "❤️"], ["👀️", "👀"], ["☝🏻", "☝🏻"], ["🏳‍🌈", "🏳️‍🌈"], ["❤‍🔥", "❤️‍🔥"], ["👁‍🗨", "👁️‍🗨️"], ["1⃣", "1️⃣"], ["🇯🇵", "🇯🇵"], ["🏴󠁧󠁢󠁳󠁣󠁴󠁿", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"]];
		for (const [s, form] of forms) expect(emojiOf(s), s).toBe(form);
		for (const s of ["🦄", "❤️", "👍🏽", "👨‍👩‍👧‍👦", "🧑🏻‍💻", "#️⃣"]) expect(emojiOf(s), s).toBe(s);
		expect(emojiOf("ok")).toBeNull();
		expect(emojiOf("👍👍")).toBeNull();
	});

});
