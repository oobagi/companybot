import { describe, expect, it } from "vitest";
import { resolveTools } from "./agents";
import { builtinTools } from "./builtin-tools";
import { companybot } from "./default-agents";
import { platformGuide } from "./guide";
import { helpPages, helpTopics, readHelp, searchHelp } from "./help";
import { toolRisk } from "./action-rules";
import { ctx, member, owner } from "../test/helpers";

const help = builtinTools.find((t) => t.id === "help.read")!;

describe("help pages", () => {
	it("each have a unique kebab-case id, a title, a one-line summary and text", () => {
		expect(new Set(helpPages.map((p) => p.id)).size).toBe(helpPages.length);
		for (const p of helpPages) {
			expect(p.id, p.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
			expect(p.title.length, p.id).toBeGreaterThan(0);
			expect(p.summary, p.id).not.toContain("\n");
			expect(p.text.length, p.id).toBeGreaterThan(100);
		}
	});

	it("point only at topics that exist (**help: topic-id**)", () => {
		const ids = new Set(helpPages.map((p) => p.id));
		for (const p of helpPages)
			for (const [, ref] of p.text.matchAll(/\*\*help: ([a-z-]+)\*\*/g)) expect(ids.has(ref!), `${p.id} points at the unknown topic "${ref}"`).toBe(true);
	});
});

describe("help.read", () => {
	const run = (input: { topic?: string; query?: string }) => help.execute(input, ctx(member)) as Promise<any>;

	it("is read-only, needs no approval and is open to every role", () => {
		expect(help.readOnly).toBe(true);
		expect(toolRisk(help)).toBe("none");
		expect(help.permission).toBeUndefined();
		for (const who of [owner, member]) expect(resolveTools({ tools: ["help.read"] }, who).map((t) => t.id)).toEqual(["help.read"]);
		expect(resolveTools({ tools: ["help.*"] }, member).map((t) => t.id)).toEqual(["help.read"]);
	});

	it("lists every topic with its id, title and summary when given nothing", async () => {
		const { topics } = await run({});
		expect(topics).toEqual(helpTopics());
		expect(topics).toHaveLength(helpPages.length);
		expect(Object.keys(topics[0]).sort()).toEqual(["id", "summary", "title"]);
	});

	it("reads one page by topic, ignoring case, and lists the topics for an unknown one", async () => {
		const page = await run({ topic: "Members" });
		expect(page).toMatchObject({ id: "members", title: expect.any(String) });
		expect(page.text).toContain("#/settings/members");
		const missing = await run({ topic: "nope" });
		expect(missing.error).toContain('No help topic "nope"');
		expect(missing.topics).toHaveLength(helpPages.length);
	});

	it("searches titles and text by keyword, best first, with short excerpts", async () => {
		const { matches } = await run({ query: "how do I invite someone" });
		expect(matches[0].id).toBe("members");
		expect(matches[0].excerpt.length).toBeLessThan(200);
		expect(Object.keys(matches[0]).sort()).toEqual(["excerpt", "id", "title"]);
		expect(searchHelp("trash restore")[0]!.id).toBe("trash");
		expect(searchHelp("webhook")[0]!.id).toBe("automations");
		expect(searchHelp("time zone notifications")[0]!.id).toBe("account-settings");
		expect(searchHelp("xyzzy")).toEqual([]);
		expect((await run({ query: "   " })).topics).toHaveLength(helpPages.length);
		expect(searchHelp("agent", 2)).toHaveLength(2);
	});

	it("prefers a topic over a query when both are given", async () => {
		expect(await run({ topic: "chat", query: "trash" })).toMatchObject({ id: "chat" });
		expect(readHelp({})).toHaveProperty("topics");
	});
});

describe("Companybot and the guide", () => {
	it("Companybot has help; the guide mentions it only when granted", () => {
		expect(companybot.tools).toContain("help.read");
		const granted = platformGuide({ tools: ["help.read"] });
		expect(granted).toContain("help_read");
		expect(granted).toContain("#/settings/members");
		expect(platformGuide({ tools: ["clock.now"] })).not.toContain("help_read");
	});
});
