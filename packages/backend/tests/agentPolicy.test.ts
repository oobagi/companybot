import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { agentTurn, agentsOf, finishTurn, generalOf, messagesIn, noMentions, ownerAndMember, turnsOf } from "./helpers";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

async function setup() {
	const { t, owner, member } = await ownerAndMember();
	const { companybot, scribe } = await agentsOf(owner);
	const chatId = (await generalOf(owner))._id;
	await owner.mutation(api.chats.addMembers, { chatId, userIds: [], agentIds: [companybot._id, scribe._id] });
	await owner.mutation(api.chats.updateChannel, { chatId, replyMode: "relevant" });
	const policy = async (patch: { agentAutonomy?: boolean; agentHandoffs?: boolean }) => {
		const settings = (await owner.query(api.workspace.settings))!;
		return owner.mutation(api.workspace.updateSettings, { name: settings.name, expectedVersion: settings.version, ...patch });
	};
	const pick = async () => {
		const messageId = await owner.mutation(api.messages.send, { chatId, text: "Can anyone help?", mentions: noMentions });
		await t.mutation(internal.router.apply, { messageId, replies: [{ agentId: companybot._id, probability: 0.9 }, { agentId: scribe._id, probability: 0.8 }], model: "test", costUsd: 0 });
		return (await turnsOf(t)).filter(turn => turn.triggerId === messageId);
	};
	return { t, owner, member, companybot, scribe, chatId, policy, pick };
}

describe("workspace agent participation", () => {
	it("stops running and queued automatic replies, refuses later tools and output, and still accepts a human mention", async () => {
		const { t, owner, companybot, chatId, policy, pick } = await setup();
		const [first, second] = await pick();
		expect(first?.status).toBe("running");
		expect(second?.status).toBe("queued");
		await policy({ agentAutonomy: false });
		expect(await t.query(internal.turns.isStopping, { turnId: first!._id })).toMatchObject({ stopped: true });
		await expect(t.mutation(internal.permissions.check, { turnId: first!._id, action: "clock.now", risk: "none" })).rejects.toThrow(/turned off/);
		await finishTurn(t, first!._id, "Must not publish this", { emoji: "👍" });
		const stopped = (await turnsOf(t)).find(turn => turn._id === second!._id);
		expect(stopped?.status).toBe("error");
		expect(stopped?.replyId).toBeUndefined();
		expect((await messagesIn(owner, { chatId })).some(m => m.text.includes("Must not publish"))).toBe(false);
		expect(await t.run(ctx => ctx.db.query("reactions").collect())).toEqual([]);
		const direct = await agentTurn(t, owner, chatId, companybot._id);
		expect(await t.query(internal.turns.isStopping, { turnId: direct })).toMatchObject({ stopped: false });
	});

	it("rechecks the master switch after a decision was scheduled and before applying its result", async () => {
		const { t, owner, companybot, chatId, policy } = await setup();
		const messageId = await owner.mutation(api.messages.send, { chatId, text: "Help?", mentions: noMentions });
		await policy({ agentAutonomy: false });
		expect(await t.query(internal.router.context, { messageId })).toBeNull();
		await t.mutation(internal.router.apply, { messageId, replies: [{ agentId: companybot._id }], model: "test", costUsd: 0 });
		expect(await turnsOf(t)).toEqual([]);
	});

	it("an approved automatic action still stops when automatic activity is turned off", async () => {
		const { t, owner, policy, pick } = await setup();
		const [turn] = await pick();
		const { approvalId } = await t.mutation(internal.approvals.request, { turnId: turn!._id, callId: "held", tool: "clock.now", input: "{}", risk: "outside" });
		await finishTurn(t, turn!._id, "Waiting for approval");
		const [card] = await owner.query(api.approvals.forReply, { replyId: turn!.replyId! });
		await owner.mutation(api.approvals.decide, { approvalId, hash: card!.hash, approve: true, always: false });
		const resumed = (await turnsOf(t)).find(row => row.approvalId === approvalId)!;
		expect(resumed.status).toBe("running");
		await policy({ agentAutonomy: false });
		expect(await t.query(internal.turns.isStopping, { turnId: resumed._id })).toMatchObject({ stopped: true });
		expect(await t.mutation(internal.approvals.claim, { turnId: resumed._id, approvalId })).toBeNull();
	});

	it.each(["agentAutonomy", "agentHandoffs"] as const)("%s off blocks explicit mentions, named handoffs and private asks", async setting => {
		const { t, owner, companybot, scribe, chatId, policy } = await setup();
		await policy({ [setting]: false });
		const turnId = await agentTurn(t, owner, chatId, companybot._id);
		expect(await t.mutation(internal.chains.askFor, { turnId, agent: scribe.name, message: "Check this" })).toHaveProperty("error");
		await finishTurn(t, turnId, "@Scribe check this", { to: scribe.name });
		expect((await turnsOf(t)).filter(turn => turn.agentId === scribe._id)).toEqual([]);
		// With no mention in the text, the structured `to` path must also stay off.
		const named = await agentTurn(t, owner, chatId, companybot._id);
		await finishTurn(t, named, "Please check this", { to: scribe.name });
		expect((await turnsOf(t)).filter(turn => turn.agentId === scribe._id)).toEqual([]);
	});

	it("turning off handoffs stops a running collaborator but permits proactive replies", async () => {
		const { t, owner, companybot, scribe, chatId, policy } = await setup();
		const root = await agentTurn(t, owner, chatId, companybot._id);
		await finishTurn(t, root, "@Scribe check this");
		const handed = (await turnsOf(t)).find(turn => turn.agentId === scribe._id)!;
		expect(handed).toMatchObject({ status: "running", handoff: true });
		await policy({ agentHandoffs: false });
		expect(await t.query(internal.turns.isStopping, { turnId: handed._id })).toMatchObject({ stopped: true });
		expect(await t.query(internal.router.nextContext, { turnId: root })).toBeNull();
		await finishTurn(t, handed._id, "Late collaborator output");
		expect((await messagesIn(owner, { chatId })).some(m => m.text.includes("Late collaborator"))).toBe(false);
		const messageId = await owner.mutation(api.messages.send, { chatId, text: "New question", mentions: noMentions });
		expect(await t.query(internal.router.context, { messageId })).not.toBeNull();
	});

	it("only workspace managers change the switches, and agents can read and change them for a manager", async () => {
		const { t, owner, member, companybot, chatId, policy } = await setup();
		const settings = (await owner.query(api.workspace.settings))!;
		await expect(member.mutation(api.workspace.updateSettings, { name: settings.name, expectedVersion: settings.version, agentAutonomy: false })).rejects.toThrow(/Only people/);
		await policy({ agentAutonomy: false });
		const turnId = await agentTurn(t, owner, chatId, companybot._id);
		const preferences = await t.mutation(internal.manageTools.runFor, { turnId, tool: "workspace.settings", input: { request: { action: "get" } } }) as { name: string; version: number; agentAutonomy: boolean };
		expect(preferences.agentAutonomy).toBe(false);
		expect(await t.mutation(internal.manageTools.runFor, { turnId, tool: "workspace.settings", input: { request: { action: "update", expectedVersion: preferences.version, agentHandoffs: false } } })).toEqual({ updated: true });
		expect(await owner.query(api.workspace.settings)).toMatchObject({ agentAutonomy: false, agentHandoffs: false });
	});

	it("a private ask cannot wake its original agent after collaboration is turned off", async () => {
		const { t, owner, companybot, scribe, chatId, policy } = await setup();
		const root = await agentTurn(t, owner, chatId, companybot._id);
		await t.mutation(internal.chains.askFor, { turnId: root, agent: scribe.name, message: "Check this" });
		await finishTurn(t, root, "I asked for a check.");
		const asked = (await turnsOf(t)).find(turn => turn.ask)!;
		await policy({ agentHandoffs: false });
		await finishTurn(t, asked._id, "The result");
		expect((await turnsOf(t)).filter(turn => turn.agentId === companybot._id)).toHaveLength(1);
		expect(await t.run(ctx => ctx.db.get(asked.ask!.wakeupId))).toMatchObject({ status: "cancelled" });
	});
});
