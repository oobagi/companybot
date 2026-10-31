import { ROUTER_MODEL, defaultModel } from "@companybot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentsOf, noMentions, ownerAndMember, turnsOf, workspaceOf } from "./helpers";

// No network: the AI SDK's decide (Jev) is stubbed, so nothing is billed. Fake timers hold the
// scheduled decision (and any reply it queues) back; tests run `router.decide` themselves.
const decideWith = vi.hoisted(() => vi.fn());
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), experimental_decide: decideWith, generateText }));

/** Jev's answer: per agent its action, and for a reaction which one, by choice name. */
type Decision = { agent: string; action: "reply" | "react" | "quiet"; emoji: string | null };
const EMOJI_NAMES: Record<string, string> = { "👍": "thumbs_up", "❤️": "heart", "🎉": "party", "😂": "laugh", "👀": "eyes", "🙏": "pray", "✅": "check", "🔥": "fire" };
const answer = (...decisions: Decision[]) =>
	decideWith.mockResolvedValue({
		answers: Object.fromEntries(
			decisions.flatMap((d) => [[d.agent, { type: "choice", choice: d.action }], ...(d.emoji ? [[`${d.agent}_emoji`, { type: "choice", choice: EMOJI_NAMES[d.emoji] ?? d.emoji }]] : [])]),
		),
		providerMetadata: { gateway: { cost: "0.0002" } },
	});

beforeEach(() => {
	vi.useFakeTimers();
	decideWith.mockReset();
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
		expect(chat!.replyMode).toBe("mentions");
		expect((await owner.query(api.chats.get, { chatId }))!.replyMode).toBe("mentions");
	});

	it("is When relevant by default: a new channel goes to the router", async () => {
		const { owner } = await ownerAndMember();
		const chatId = await owner.mutation(api.chats.createChannel, { name: "fresh", private: false });
		expect((await owner.query(api.chats.get, { chatId }))!.replyMode).toBe("relevant");
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

		const call = decideWith.mock.calls[0]![0];
		expect(call.model).toBe(ROUTER_MODEL);
		expect(call.state).toContain('"What\'s on the calendar for Friday?"');
		expect(call.state).toContain("a1: Companybot");
		expect(call.state).toContain("a2: Scribe");
		expect(Object.keys(call.questions)).toEqual(expect.arrayContaining(["a1", "a2"]));
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
		expect(decideWith).not.toHaveBeenCalled();
		await decide(last);
		expect(decideWith).toHaveBeenCalledTimes(1);
		const { state: prompt } = decideWith.mock.calls[0]![0];
		expect(prompt).toContain('"hey team"');
		expect(prompt).toContain('"hi!"');
		expect(prompt.indexOf("Newest message")).toBeLessThan(prompt.indexOf("summarize yesterday"));
	});

	it("skips messages that @mention an agent: they answer as today", async () => {
		const { t, owner, companybot, chatId, decide, scheduled } = await setUp();
		const messageId = await owner.mutation(api.messages.send, { chatId, text: "status?", mentions: { userIds: [], agentIds: [companybot._id] } });
		expect(await scheduled()).toEqual([]);
		await decide(messageId);
		expect(decideWith).not.toHaveBeenCalled();
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
		expect(decideWith).not.toHaveBeenCalled();
		expect(await scheduled()).toEqual([]);
	});

	it("routes thread replies into the thread, with its parent in the prompt", async () => {
		const { t, owner, member, companybot, send, decide } = await setUp();
		const parent = await send(owner, "Q3 plan draft is up");
		const reply = await send(member, "can you list the open tasks for it?", parent);
		answer({ agent: "a1", action: "reply", emoji: null });
		await decide(reply);
		expect(decideWith.mock.calls[0]![0].state).toMatch(/In a thread under this message:\n\[[^\]]+\] "Q3 plan draft is up"/);
		expect(await turnsOf(t)).toEqual([expect.objectContaining({ agentId: companybot._id, threadId: parent, triggerId: reply })]);
	});

	it("drops agents that left (or the setting going back) between the call and its answer", async () => {
		const { t, owner, member, scribe, chatId, send, decide } = await setUp();
		const messageId = await send(member, "Scribe, take notes please");
		decideWith.mockImplementation(async () => {
			await owner.mutation(api.chats.removeMember, { chatId, agentId: scribe._id });
			return { answers: { a2: { type: "choice", choice: "reply" } }, providerMetadata: {} };
		});
		await decide(messageId);
		expect(await turnsOf(t)).toEqual([]);

		await owner.mutation(api.chats.addMembers, { chatId, userIds: [], agentIds: [scribe._id] });
		decideWith.mockImplementation(async () => {
			await owner.mutation(api.chats.updateChannel, { chatId, replyMode: "mentions" });
			return { answers: { a1: { type: "choice", choice: "reply" } }, providerMetadata: {} };
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
		expect(decideWith.mock.calls[0]![0].state).toContain("Can't react.");
	});

	it("uses the workspace's pick: a language model answers the same rules as JSON", async () => {
		const { t, owner, member, companybot, send, decide } = await setUp();
		const settings = (await owner.query(api.workspace.settings))!;
		expect(settings.routerModel).toBe(ROUTER_MODEL);
		expect(settings.routerModels.map((m) => m.id)).toEqual(expect.arrayContaining([ROUTER_MODEL, defaultModel]));
		await expect(owner.mutation(api.workspace.updateSettings, { name: settings.name, routerModel: "made/up", expectedVersion: settings.version })).rejects.toThrow("reply decision models");
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, routerModel: defaultModel, expectedVersion: settings.version });

		const messageId = await send(member, "What's on the calendar for Friday?");
		generateText.mockResolvedValue({ output: { decisions: [{ agent: "a1", action: "reply", emoji: null }] }, providerMetadata: {} });
		await decide(messageId);
		expect(decideWith).not.toHaveBeenCalled();
		expect(generateText.mock.calls[0]![0].model).toBe(defaultModel);
		expect((await turnsOf(t)).map((turn) => turn.agentId)).toEqual([companybot._id]);
		expect((await t.run((ctx) => ctx.db.query("usage").collect()))[0]?.model ?? defaultModel).toBe(defaultModel);
	});
});
