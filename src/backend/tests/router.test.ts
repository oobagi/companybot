import { ROUTER_MODEL } from "@companybot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentsOf, noMentions, ownerAndMember, turnsOf, workspaceOf } from "./helpers";

// No network: the AI SDK's generateText is stubbed, so nothing is billed. Fake timers hold the
// scheduled decision (and any reply it queues) back; tests run `router.decide` themselves.
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));

type Decision = { agent: string; action: "reply" | "react" | "quiet"; emoji: string | null };
const answer = (...decisions: Decision[]) => generateText.mockResolvedValue({ output: { decisions }, providerMetadata: { gateway: { cost: "0.0002" } } });

beforeEach(() => {
	vi.useFakeTimers();
	generateText.mockReset();
	answer();
});
afterEach(() => void vi.useRealTimers());

/** #ops with Companybot (a1) then Scribe (a2), set to `replyMode`. */
async function setUp(replyMode: "mentions" | "relevant" = "relevant") {
	const { t, owner, member } = await ownerAndMember();
	const { companybot, scribe } = await agentsOf(owner);
	const chatId = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
	await owner.mutation(api.chats.addMembers, { chatId, userIds: [member.userId], agentIds: [companybot._id, scribe._id] });
	await owner.mutation(api.chats.updateChannel, { chatId, replyMode });
	const send = (as: typeof owner, text: string, threadId?: Id<"chatMessages">) => as.mutation(api.messages.send, { chatId, threadId, text, mentions: noMentions });
	const decide = (messageId: Id<"chatMessages">) => t.action(internal.router.decide, { messageId });
	const scheduled = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) => f.name.startsWith("router")));
	return { t, owner, member, companybot, scribe, chatId, send, decide, scheduled };
}

describe("reply router", () => {
	it("leaves Mentions only channels exactly as before: no decision, no turns", async () => {
		const { t, owner, chatId, send, scheduled } = await setUp("mentions");
		await send(owner, "Can someone pull last month's revenue?");
		expect(await scheduled()).toEqual([]);
		expect(await turnsOf(t)).toEqual([]);
		const chat = await t.run((ctx) => ctx.db.get(chatId));
		// "mentions" is stored as unset, like every channel from before the setting.
		expect(chat!.replyMode).toBeUndefined();
		expect((await owner.query(api.chats.get, { chatId }))!.replyMode).toBe("mentions");
	});

	it("only lets the channel's managers change it", async () => {
		const { member, chatId } = await setUp();
		await expect(member.mutation(api.chats.updateChannel, { chatId, replyMode: "mentions" })).rejects.toThrow("Only the channel's creator or an owner");
	});

	it("queues a reply for the agent it picks, as the person who wrote, and records its cost", async () => {
		const { t, member, companybot, chatId, send, decide, scheduled } = await setUp();
		const messageId = await send(member, "What's on the calendar for Friday?");
		expect((await scheduled()).map((f) => f.args[0])).toEqual([{ messageId }]);
		answer({ agent: "a1", action: "reply", emoji: null }, { agent: "a2", action: "quiet", emoji: null });
		await decide(messageId);

		const call = generateText.mock.calls[0]![0];
		expect(call.model).toBe(ROUTER_MODEL);
		expect(call.prompt).toContain('"What\'s on the calendar for Friday?"');
		expect(call.prompt).toContain("a1: Companybot");
		expect(call.prompt).toContain("a2: Scribe");
		const turns = await turnsOf(t);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ agentId: companybot._id, chatId, triggerId: messageId, actorId: member.userId, routed: true, status: "running" });
		const usage = await t.run((ctx) => ctx.db.query("usage").collect());
		expect(usage).toEqual([expect.objectContaining({ userId: member.userId, kind: "router", model: ROUTER_MODEL, costUsd: 0.0002 })]);
		expect(usage[0]!.agentId).toBeUndefined();
		// The reply's prompt says nobody mentioned it.
		const context = await t.query(internal.turns.turnContext, { turnId: turns[0]!._id });
		expect(context.routed).toBe(true);
	});

	it("reacts for the agent it picks, and a second decision doesn't take the reaction back", async () => {
		const { t, member, scribe, send, decide } = await setUp();
		const messageId = await send(member, "thanks Scribe!");
		answer({ agent: "a2", action: "react", emoji: "🙏" });
		await decide(messageId);
		await decide(messageId);
		const reactions = await t.run((ctx) => ctx.db.query("reactions").collect());
		expect(reactions).toEqual([expect.objectContaining({ messageId, emoji: "🙏", agentId: scribe._id })]);
		expect(await turnsOf(t)).toEqual([]);
	});

	it("does nothing when it picks quiet for everyone, but still records the call", async () => {
		const { t, owner, member, send, decide } = await setUp();
		await send(owner, "lunch at noon?");
		const messageId = await send(member, "sure, tacos");
		await decide(messageId);
		expect(await turnsOf(t)).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([]);
		expect((await t.run((ctx) => ctx.db.query("usage").collect())).map((u) => u.kind)).toEqual(["router"]);
	});

	it("makes one decision for a burst: the newest message's, which sees the ones before it", async () => {
		const { owner, member, send, decide } = await setUp();
		const first = await send(owner, "hey team");
		const second = await send(member, "hi!");
		const last = await send(owner, "Companybot can you summarize yesterday's leads");
		await decide(first);
		await decide(second);
		expect(generateText).not.toHaveBeenCalled();
		await decide(last);
		expect(generateText).toHaveBeenCalledTimes(1);
		const { prompt } = generateText.mock.calls[0]![0];
		expect(prompt).toContain('"hey team"');
		expect(prompt).toContain('"hi!"');
		expect(prompt.indexOf("Newest message")).toBeLessThan(prompt.indexOf("summarize yesterday"));
	});

	it("skips messages that @mention an agent: they answer as today", async () => {
		const { t, owner, companybot, chatId, decide, scheduled } = await setUp();
		const messageId = await owner.mutation(api.messages.send, { chatId, text: "status?", mentions: { userIds: [], agentIds: [companybot._id] } });
		expect(await scheduled()).toEqual([]);
		await decide(messageId);
		expect(generateText).not.toHaveBeenCalled();
		expect((await turnsOf(t)).map((x) => x.agentId)).toEqual([companybot._id]);
	});

	it("never decides on an agent's message", async () => {
		const { t, owner, companybot, chatId, decide, scheduled } = await setUp();
		const workspaceId = await workspaceOf(owner);
		const messageId = await t.run((ctx) =>
			ctx.db.insert("chatMessages", {
				workspaceId: workspaceId,
				chatId,
				authorAgentId: companybot._id,
				text: "Here's the summary.",
				parts: [],
				mentions: noMentions,
				status: "done",
			}),
		);
		await decide(messageId);
		expect(generateText).not.toHaveBeenCalled();
		expect(await scheduled()).toEqual([]);
	});

	it("routes thread replies into the thread, with its parent in the prompt", async () => {
		const { t, owner, member, companybot, send, decide } = await setUp();
		const parent = await send(owner, "Q3 plan draft is up");
		const reply = await send(member, "can you list the open tasks for it?", parent);
		answer({ agent: "a1", action: "reply", emoji: null });
		await decide(reply);
		expect(generateText.mock.calls[0]![0].prompt).toMatch(/In a thread under this message:\n\[[^\]]+\] "Q3 plan draft is up"/);
		expect(await turnsOf(t)).toEqual([expect.objectContaining({ agentId: companybot._id, threadId: parent, triggerId: reply })]);
	});

	it("drops agents that left (or the setting going back) between the call and its answer", async () => {
		const { t, owner, member, scribe, chatId, send, decide } = await setUp();
		const messageId = await send(member, "Scribe, take notes please");
		generateText.mockImplementation(async () => {
			await owner.mutation(api.chats.removeMember, { chatId, agentId: scribe._id });
			return { output: { decisions: [{ agent: "a2", action: "reply", emoji: null }] }, providerMetadata: {} };
		});
		await decide(messageId);
		expect(await turnsOf(t)).toEqual([]);

		await owner.mutation(api.chats.addMembers, { chatId, userIds: [], agentIds: [scribe._id] });
		generateText.mockImplementation(async () => {
			await owner.mutation(api.chats.updateChannel, { chatId, replyMode: "mentions" });
			return { output: { decisions: [{ agent: "a1", action: "reply", emoji: null }] }, providerMetadata: {} };
		});
		await decide(messageId);
		expect(await turnsOf(t)).toEqual([]);
	});

	it("doesn't let an agent without chat.react react", async () => {
		const { t, member, scribe, send, decide } = await setUp();
		await t.run((ctx) => ctx.db.patch(scribe._id, { tools: ["memory.search"] }));
		const messageId = await send(member, "thanks Scribe!");
		answer({ agent: "a2", action: "react", emoji: "🙏" });
		await decide(messageId);
		expect(await t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([]);
		expect(generateText.mock.calls[0]![0].prompt).toContain("Can't react.");
	});
});
