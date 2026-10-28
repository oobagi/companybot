import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { APPROVAL_TTL_MS, approvalHash, canonicalJson } from "@companybot/core";

import { type As, workspaceOf, inWorkspace, sideWorkspace, agentsOf, ownerAndMember, generalOf, turnsOf } from "./helpers";
import "./connectorFixtures";

// The tests drive turns themselves; keep scheduled model replies back.
beforeEach(() => void vi.useFakeTimers());

afterEach(() => void vi.useRealTimers());

describe("approvals", () => {
	const call = { tool: "crm.send_sms", input: { to: "+15550100", body: "See you at 3" } };

	/** The member asks Companybot in `chatId`; the reply holds `call` for approval. Returns the asking turn and approval. */
	async function holdCall(t: ReturnType<typeof convexTest>, as: As, chatId: Id<"chats">, finish = true) {
		const { companybot } = await agentsOf(as);
		await as.mutation(api.messages.send, { chatId, text: "@Companybot text Bob", mentions: { userIds: [], agentIds: [companybot._id] } });
		// The test plays the runner, so the real one (a model call) must not race it.
		await t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
		});
		const turn = (await turnsOf(t)).at(-1)!;
		// What the runner stores before calling the model; set here so no model call is needed.
		await t.mutation(internal.turns.savePrompt, { turnId: turn._id, prompt: "Reply to this message: text Bob" });
		const { approvalId } = await t.mutation(internal.approvals.request, {
			turnId: turn._id,
			callId: "c1",
			tool: call.tool,
			input: canonicalJson(call.input),
			risk: "outside",
		});
		const parts = [{ type: "approval" as const, id: "c1", approvalId, tool: call.tool }];
		await t.mutation(internal.turns.updateReply, { replyId: turn.replyId!, text: "", parts });
		if (finish) await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		const [card] = await as.query(api.approvals.forReply, { replyId: turn.replyId! });
		return { turn, approvalId, card: card! };
	}

	it("shows the exact call to the chat, and lets only the person the agent acts for decide", async () => {
		const { t, owner, member } = await ownerAndMember();
		const chatId = (await generalOf(owner))._id;
		const { turn, approvalId, card } = await holdCall(t, member, chatId);
		expect(card).toMatchObject({
			service: "CRM",
			action: "Send SMS",
			input: canonicalJson(call.input),
			status: "pending",
			approver: "member@co.com",
			canDecide: true,
		});
		expect(card.hash).toBe(await approvalHash(call.tool, call.input));
		const [theirs] = await owner.query(api.approvals.forReply, { replyId: turn.replyId! });
		expect(theirs).toMatchObject({ canDecide: false, input: card.input });

		const reply = (await owner.query(api.messages.list, { chatId })).find((m) => m._id === turn.replyId)!;
		expect(reply.parts).toMatchObject([{ type: "approval", tool: call.tool }]);

		// Owners can't approve for someone else: the call would run as them.
		await expect(owner.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false })).rejects.toThrow(
			"Only member@co.com can decide this",
		);
		expect((await member.query(api.approvals.forReply, { replyId: turn.replyId! }))[0]?.status).toBe("pending");
	});

	it("cannot decide, claim, create approvals or use tools in a trashed channel", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = await member.mutation(api.chats.createChannel, { name: "sales", private: false });
		const { turn, approvalId, card } = await holdCall(t, member, chatId);
		await member.mutation(api.trash.move, { kind: "channel", id: chatId });
		expect(await member.query(api.approvals.forReply, { replyId: turn.replyId! })).toEqual([]);
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false })).rejects.toThrow("Approval not found");
		await member.mutation(api.trash.restore, { kind: "channel", id: chatId });
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false });
		const resume = (await turnsOf(t)).at(-1)!;
		await member.mutation(api.trash.move, { kind: "channel", id: chatId });
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: resume._id })).toBeNull();
		await expect(t.query(internal.turns.turnContext, { turnId: resume._id })).rejects.toThrow("no longer see this chat");
		await expect(t.mutation(internal.approvals.request, { turnId: resume._id, callId: "late", tool: call.tool, input: canonicalJson(call.input), risk: "outside" })).rejects.toThrow("no longer see this chat");
	});

	it("refuses a hash other than the stored call's, and decided or expired requests", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { approvalId, card } = await holdCall(t, member, chatId);
		const otherHash = await approvalHash(call.tool, { ...call.input, body: "See you at 4" });
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: otherHash, approve: true, always: false })).rejects.toThrow(
			"isn't the one you were shown",
		);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: false, always: false });
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false })).rejects.toThrow("already decided");
		await t.mutation(internal.turns.finishReply, { turnId: (await turnsOf(t)).at(-1)!._id });

		const second = await holdCall(t, member, chatId);
		const now = Date.now();
		vi.setSystemTime(now + APPROVAL_TTL_MS + 1);
		try {
			expect(second.card.status).toBe("pending");
			const [now] = await member.query(api.approvals.forReply, { replyId: second.turn.replyId! });
			expect(now?.status).toBe("expired");
			await expect(
				member.mutation(api.approvals.decide, { approvalId: second.approvalId, hash: second.card.hash, approve: true, always: false }),
			).rejects.toThrow("expired");
		} finally {
			vi.setSystemTime(now);
		}
	});

	it("can't be decided once the person can't see the chat", async () => {
		const { t, owner, member } = await ownerAndMember();
		const chatId = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		await owner.mutation(api.chats.addMembers, { chatId, userIds: [member.userId], agentIds: [] });
		const { approvalId, card } = await holdCall(t, member, chatId);
		await member.mutation(api.chats.leave, { chatId });
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false })).rejects.toThrow("not found");
	});

	it("queues an approved call behind the running turn, then runs exactly what was approved, once", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { turn, approvalId, card } = await holdCall(t, member, chatId, false);

		// Decided while the asking reply is still running: it waits its turn in the place.
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false });
		expect((await turnsOf(t)).map((x) => x.status)).toEqual(["running", "queued"]);
		await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		const next = (await turnsOf(t))[1]!;
		expect(next).toMatchObject({ status: "running", approvalId, triggerId: turn.triggerId });

		const context = await t.query(internal.turns.turnContext, { turnId: next._id });
		expect(context.approval).toMatchObject({ id: approvalId, tool: call.tool, status: "approved", by: "member@co.com" });
		// The held call replays the same way whatever happens to it (prompt caching), and no message is re-asked.
		expect(context.session.turns.at(-1)?.reply).toBe("[Held for approval: crm.send_sms]");
		expect(context.messages.some((m) => m.id === turn.triggerId)).toBe(false);

		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toEqual(call);
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
		await t.mutation(internal.approvals.finish, { approvalId, result: '{"sent":true}' });
		const [mine] = await member.query(api.approvals.forReply, { replyId: turn.replyId! });
		expect(mine).toMatchObject({ status: "done", result: '{"sent":true}' });
	});

	it("keeps a turn, its connectors and its approval in their workspace when the person switches", async () => {
		const { t, owner, member } = await ownerAndMember();
		const acme = await workspaceOf(owner);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "k" } });
		const chatId = (await generalOf(member))._id;
		const { turn, approvalId, card } = await holdCall(t, member, chatId);

		// The member also runs a workspace of their own, and switches to it on every device.
		const side = (await sideWorkspace(t, "member@co.com")).workspaceId;
		await member.mutation(api.workspace.switchTo, { to: side });
		const userId = member.userId;
		expect(await t.query(internal.connectors.forTurn, { userId, workspaceId: side, connectorIds: ["crm"] })).toEqual([]);

		// Deciding from a window with the side workspace open finds nothing there...
		await expect(
			inWorkspace(member, side).mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false }),
		).rejects.toThrow("not found");
		// ...from Acme's, it resumes in Acme, acting as Acme's member with Acme's connection.
		await inWorkspace(member, acme).mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false });
		const next = (await turnsOf(t)).at(-1)!;
		expect(next).toMatchObject({ status: "running", approvalId, workspaceId: acme });
		const context = await t.query(internal.turns.turnContext, { turnId: next._id });
		expect(context.member).toMatchObject({ userId, workspaceId: acme, role: "member" });
		expect(await t.query(internal.connectors.forTurn, { userId, workspaceId: context.member.workspaceId, connectorIds: ["crm"] })).toHaveLength(1);
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toEqual(call);
		expect(turn.workspaceId).toBe(acme);
	});

	it("runs nothing if the stored call no longer matches what was approved", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { approvalId, card } = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false });
		const next = (await turnsOf(t)).at(-1)!;
		await t.run((ctx) => ctx.db.patch(approvalId, { input: canonicalJson({ ...call.input, to: "+15550199" }) }));
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
		const row = await t.run((ctx) => ctx.db.get(approvalId));
		expect(row).toMatchObject({ status: "failed", error: "The stored action no longer matches what was approved." });
	});

	it("doesn't leave an approval running when its turn ends without finishing it", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const first = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId: first.approvalId, hash: first.card.hash, approve: true, always: false });
		await t.mutation(internal.turns.finishReply, { turnId: (await turnsOf(t)).at(-1)!._id, error: "Boom" });
		expect(await t.run((ctx) => ctx.db.get(first.approvalId))).toMatchObject({ status: "failed", error: expect.stringContaining("before running it") });

		const second = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId: second.approvalId, hash: second.card.hash, approve: true, always: false });
		const next = (await turnsOf(t)).at(-1)!;
		await t.mutation(internal.approvals.claim, { approvalId: second.approvalId, turnId: next._id });
		await t.mutation(internal.turns.finishReply, { turnId: next._id, error: "Timed out" });
		expect(await t.run((ctx) => ctx.db.get(second.approvalId))).toMatchObject({ status: "failed", error: expect.stringContaining("may or may not have happened") });
	});

	it("tells the agent about a denial and runs nothing", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { approvalId, card } = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: false, always: false });
		const next = (await turnsOf(t)).at(-1)!;
		expect(next).toMatchObject({ status: "running", approvalId });
		expect((await t.query(internal.turns.turnContext, { turnId: next._id })).approval?.status).toBe("denied");
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
	});
});
