import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { describe, expect, it } from "vitest";
import { emojiCandidates, type Sources, candidatesFor, findTrigger, matches } from "./editor";
import { buildIndex } from "./emoji";

describe("composer triggers", () => {
	it("finds the trigger being typed at the caret, at the start or after a space", () => {
		expect(findTrigger("@", "@")).toEqual({ start: 0, query: "" });
		expect(findTrigger("hi @ad", "@")).toEqual({ start: 3, query: "ad" });
		expect(findTrigger("see #sal", "#")).toEqual({ start: 4, query: "sal" });
		expect(findTrigger("/prop", "/")).toEqual({ start: 0, query: "prop" });
	});

	it("lets @ take one space for two-word names, the others none", () => {
		expect(findTrigger("@Sam L", "@")).toEqual({ start: 0, query: "Sam L" });
		expect(findTrigger("@Sam Lee hi", "@")).toBeNull();
		expect(findTrigger("#sales now", "#")).toBeNull();
		expect(findTrigger("/proposal for", "/")).toBeNull();
	});

	it("ignores a trigger inside a word, like an email or a path", () => {
		expect(findTrigger("ada@co", "@")).toBeNull();
		expect(findTrigger("http://x", "/")).toBeNull();
		expect(findTrigger("c#", "#")).toBeNull();
	});

	it("matches the start of a name or of any word in it", () => {
		expect(matches("Sam Lee", "le")).toBe(true);
		expect(matches("sales-west", "west")).toBe(true);
		expect(matches("Sam Lee", "am")).toBe(false);
	});

	it("offers people and agents for @, channels for #, skills for /", () => {
		const sources: Sources = {
			people: [{ type: "user" as const, id: "u1" as Id<"users">, name: "Ada Lovelace" }],
			agents: [{ type: "agent" as const, id: "a1" as Id<"agents">, name: "Companybot" }],
			channels: [{ id: "c1" as Id<"chats">, name: "sales", topic: null, private: false, joined: true }],
			skills: [{ id: "s1", name: "Proposal", description: "Write one" }],
		};
		expect(candidatesFor(sources, "@", "").map((c) => c.label)).toEqual(["Ada Lovelace", "Companybot"]);
		expect(candidatesFor(sources, "@", "love").map((c) => c.kind)).toEqual(["user"]);
		expect(candidatesFor(sources, "#", "sa")).toMatchObject([{ kind: "channel", id: "c1", label: "sales" }]);
		expect(candidatesFor(sources, "/", "pro")).toMatchObject([{ kind: "skill", id: "s1", label: "Proposal" }]);
		expect(candidatesFor(sources, "/", "zzz")).toEqual([]);
	});

	it("opens the emoji menu on a colon, at the start or after a space, not in a time or a word", () => {
		expect(findTrigger(":smi", ":")).toEqual({ start: 0, query: "smi" });
		expect(findTrigger("nice :+1", ":")).toEqual({ start: 5, query: "+1" });
		expect(findTrigger(":smile: ", ":")).toBeNull();
		expect(findTrigger("10:30", ":")).toBeNull();
		expect(findTrigger("note:smi", ":")).toBeNull();
	});

	it("offers emoji from two letters, named by shortcode", () => {
		const index = buildIndex([{ hexcode: "1F604", label: "grinning face with smiling eyes", unicode: "😄", group: 0, order: 1 }], { "1F604": "smile" });
		expect(emojiCandidates(index, "s")).toEqual([]);
		expect(emojiCandidates(index, "sm")).toEqual([{ kind: "emoji", id: "smile", label: "😄" }]);
	});
});
