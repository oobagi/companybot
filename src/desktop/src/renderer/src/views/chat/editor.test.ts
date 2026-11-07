import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { describe, expect, it, vi } from "vitest";
import { type Menu, type Sources, SuggestionMenu, candidatesFor, emojiCandidates, findTrigger, matches, typedMentions } from "./editor";
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

	it("lists the emoji panel's tiles for the typed query: the matches, everything with nothing typed, nothing for no match", () => {
		const index = buildIndex([{ hexcode: "1F604", label: "grinning face with smiling eyes", unicode: "😄", group: 0, order: 1 }], { "1F604": "smile" });
		const store = { getItem: () => null, setItem: () => {} };
		expect(emojiCandidates(index, "sm", store)).toEqual([{ kind: "emoji", id: "😄", label: "😄" }]);
		expect(emojiCandidates(index, "", store)).toEqual([{ kind: "emoji", id: "😄", label: "😄" }]);
		expect(emojiCandidates(index, "zzz", store)).toEqual([]);
	});
});

describe("typed mentions", () => {
	const sam = { type: "user" as const, id: "u1" as Id<"users">, name: "Sam" };
	const samLee = { type: "user" as const, id: "u2" as Id<"users">, name: "Sam Lee" };
	const scout = { type: "agent" as const, id: "a1" as Id<"agents">, name: "Scout" };
	const sources = { people: [sam, samLee], agents: [scout] };
	const names = (text: string) => typedMentions(text, sources).map((p) => p.name);

	it("finds a pasted @name that never became a chip", () => {
		expect(names("@Scout find 3 plumbers")).toEqual(["Scout"]);
		expect(names("hey @Scout, and @Sam.")).toEqual(["Scout", "Sam"]);
	});

	it("takes the longest name, and only whole names", () => {
		expect(names("@Sam Lee can you")).toEqual(["Sam Lee"]);
		expect(names("@Scouts @scout me@Scout Scout")).toEqual([]);
	});
});

describe("records in the @ menu", () => {
	it("follows people and agents, searched once typing pauses, and narrows as you type", async () => {
		vi.useFakeTimers();
		const search = vi.fn(async (query: string) =>
			[{ id: "r1" as Id<"records">, name: "Summit Homes", typeKey: "client", typeName: "Clients" }, { id: "r2" as Id<"records">, name: "Sunrise Deck", typeKey: "deal", typeName: "Deals" }].filter((r) => matches(r.name, query)),
		);
		const sources: Sources = { people: [{ type: "user", id: "u1" as Id<"users">, name: "Sue" }], agents: [], channels: [], skills: [], records: search };
		let menu: Menu | null = null;
		const suggestions = new SuggestionMenu(() => sources, (m) => (menu = m));
		const options = suggestions.suggestion("@");
		const renderer = options.render!();
		const type = async (query: string) => {
			const items = await options.items!({ query, editor: undefined as never, signal: new AbortController().signal });
			renderer.onUpdate!({ query, items, command: () => {} } as never);
			return items.map((c) => c.label);
		};
		// People at once; records only after the pause, in one search.
		expect(await type("s")).toEqual(["Sue"]);
		expect(await type("su")).toEqual(["Sue"]);
		await vi.advanceTimersByTimeAsync(200);
		expect(search.mock.calls.map(([q]) => q)).toEqual(["su"]);
		expect(menu!.items.map((c) => `${c.kind}:${c.label}`)).toEqual(["user:Sue", "record:Summit Homes", "record:Sunrise Deck"]);
		// Typing on narrows what was found before the next search answers.
		expect(await type("sum")).toEqual(["Summit Homes"]);
		vi.useRealTimers();
	});
});
