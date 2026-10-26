import { describe, expect, it } from "vitest";
import type { Participant } from "./chat";
import { platformGuide } from "./guide";
import { type PlaceMessage, type TurnPromptInput, buildTurnInput, buildTurnPrompt } from "./turn-input";

describe("turn input", () => {
	const ada = { type: "user" as const, id: "u1", name: "Ada" };
	const ben = { type: "user" as const, id: "u2", name: "Ben" };
	const bot = { type: "agent" as const, id: "a1", name: "Companybot" };
	const scribeP = { type: "agent" as const, id: "a2", name: "Scribe" };
	const at = (minute: number) => Date.UTC(2026, 9, 22, 15, minute);
	const msg = (id: string, author: Participant, text: string, minute: number, extra: Partial<PlaceMessage> = {}): PlaceMessage => ({
		id,
		author,
		text,
		time: at(minute),
		...extra,
	});
	const base: TurnPromptInput = {
		agentId: "a1",
		place: { kind: "channel", name: "sales", private: false, topic: "Deals", thread: null, members: [ada, ben, bot, scribeP] },
		actor: { name: "Ada", email: "ada@co.com", role: "owner", timeZone: "America/Los_Angeles" },
		memory: "team",
		connectors: { connected: [], unavailable: [] },
		messages: [
			msg("m1", ben, "Morning", 1, { replyCount: 3 }),
			msg("m2", scribeP, "Draft is up", 2, { edited: true }),
			msg("m3", ada, "@Companybot status?", 3),
			msg("m4", ben, "Also this", 4),
		],
		triggerId: "m3",
	};

	it("says where you are, lists what's new, and marks the trigger last", () => {
		expect(buildTurnPrompt(base)).toBe(
			[
				"Where you are: #sales, a public channel. Topic: Deals.",
				"Here: Ada, Ben (people); Scribe (agents).",
				"Ada <ada@co.com>, a workspace owner, asked for you. You act with their access. Their time zone: America/Los_Angeles.",
				"Memory: team memories only. 2+ people can read this chat, so personal memories are off.",
				"",
				"New here since your last reply (times in America/Los_Angeles):",
				"[Ben 10-22 08:01] Morning (3 replies in thread m1)",
				"[Scribe 10-22 08:02] Draft is up (edited)",
				"[Ben 10-22 08:04] Also this",
				"",
				"Reply to this message from Ada:",
				"[Ada 10-22 08:03] @Companybot status?",
			].join("\n"),
		);
	});

	it("names DMs, starts a thread's first turn with its parent, and caps long backlogs", () => {
		const many = Array.from({ length: 60 }, (_, i) => msg(`x${i}`, ben, `n${i}`, i % 60));
		const prompt = buildTurnPrompt({
			...base,
			place: { kind: "dm", name: null, private: true, topic: null, members: [ben, bot], thread: { parent: msg("p", ben, "Plan", 0), first: true } },
			memory: "personal",
			connectors: { connected: [], unavailable: ["CRM"] },
			messages: [...many, msg("t", ben, "Go", 59)],
			triggerId: "t",
		});
		expect(prompt).toContain("Where you are: a DM with Ben, in a thread.");
		expect(prompt).toContain("Memory: personal and team memories.");
		expect(buildTurnPrompt({ ...base, memory: "off" })).toContain("Memory: off. An owner turned memory off");
		expect(prompt).toContain("Unavailable this turn, so you can't use them: CRM.");
		expect(prompt).toContain("The thread is under this message:\n[Ben 10-22 08:00] Plan");
		expect(prompt).toContain("(10 earlier messages not shown. Use chat_read for them.)");
		expect(prompt).not.toContain("] n9\n");
		expect(prompt).toContain("] n10\n");
	});

	it("replays past turns exactly and keeps the system prompt free of per-turn content", () => {
		const input = buildTurnInput({
			agent: { instructions: "Be brief.", tools: ["chat.*"] },
			skills: [],
			session: { summary: "- Talked about Q4", turns: [{ prompt: "P1", reply: "R1" }, { prompt: "P2", reply: "" }] },
			prompt: "P3",
		});
		expect(input.instructions).toBe(`Be brief.\n\n${platformGuide({ tools: ["chat.*"] })}`);
		expect(input.messages).toEqual([
			{ role: "user", content: "Summary of your earlier turns here:\n- Talked about Q4\n\nP1" },
			{ role: "assistant", content: "R1" },
			{ role: "user", content: "P2" },
			{ role: "assistant", content: "(No reply.)" },
			{ role: "user", content: "P3" },
		]);
	});
});
