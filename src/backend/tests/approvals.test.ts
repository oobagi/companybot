import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { APPROVAL_TTL_MS, approvalHash, canonicalJson } from "@companybot/core";

import { type As, agentTurn, workspaceOf, inWorkspace, sideWorkspace, agentsOf, ownerAndMember, generalOf, turnsOf, messagesIn } from "./helpers";
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
		// The step as the runner keeps it: the call, with no result (it's held).
		await t.mutation(internal.turns.keepStep, { turnId: turn._id, messages: JSON.stringify([{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "crm_send_sms", input: call.input }] }]) });
		const parts = [{ type: "approval" as const, id: "c1", approvalId, tool: call.tool }];
		await t.mutation(internal.turns.updateReply, { turnId: turn._id, text: "", parts });
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

		const reply = (await messagesIn(owner, { chatId })).find((m) => m._id === turn.replyId)!;
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
		await expect(t.mutation(internal.turns.turnContext, { turnId: resume._id })).rejects.toThrow("no longer see this chat");
		await expect(t.mutation(internal.approvals.request, { turnId: resume._id, callId: "late", tool: call.tool, input: canonicalJson(call.input), risk: "outside" })).rejects.toThrow("no longer see this chat");
	});

	it("refuses a hash other than the stored call's and expired requests, and ignores a second answer", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { approvalId, card } = await holdCall(t, member, chatId);
		const otherHash = await approvalHash(call.tool, { ...call.input, body: "See you at 4" });
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: otherHash, approve: true, always: false })).rejects.toThrow(
			"isn't the one you were shown",
		);
		expect(await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: false, always: false })).toEqual({ decided: true });
		// A second answer (another device, a double click) changes nothing, and isn't an error the app would log.
		const turns = (await turnsOf(t)).length;
		expect(await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false })).toEqual({ decided: false });
		expect(await t.run((ctx) => ctx.db.get("approvals", approvalId))).toMatchObject({ status: "denied" });
		expect((await turnsOf(t)).length).toBe(turns);
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

	it("names what a held call does and what it touches, only as the viewer may see it", async () => {
		const { t, owner, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const notes = await member.mutation(api.pages.create, { title: "Old pricing notes" });
		const secret = await owner.mutation(api.pages.create, { title: "Board minutes" });
		await owner.mutation(api.pages.setAccess, { pageId: secret, access: [] });
		const { companybot } = await agentsOf(member);
		const held = async (callId: string, page: Id<"pages">) => {
			const turnId = await agentTurn(t, member, chatId, companybot._id);
			const input = { page, trash: true };
			const { approvalId } = await t.mutation(internal.approvals.request, { turnId, callId, tool: "pages.write", input: canonicalJson(input), risk: "locked" });
			await t.mutation(internal.turns.updateReply, { turnId, text: "", parts: [{ type: "approval", id: callId, approvalId, tool: "pages.write" }] });
			await t.mutation(internal.turns.finishReply, { turnId });
			const replyId = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
			return (await member.query(api.approvals.forReply, { replyId }))[0]!;
		};
		const card = await held("c-notes", notes);
		expect(card).toMatchObject({ action: "Archive page", fields: [{ key: "page", value: "Old pricing notes" }] });
		expect(card.ask).toContain("archive page Old pricing notes");
		// An id the approver can't open says what it is, never its name; Raw keeps the exact input.
		const hidden = await held("c-secret", secret);
		expect(hidden.fields).toEqual([{ key: "page", value: "a page you can't see" }]);
		expect(JSON.stringify(hidden)).not.toContain("Board minutes");
		expect(JSON.parse(hidden.input)).toEqual({ page: secret, trash: true });
	});

	describe("naming ids on cards, bounded", () => {
		/** `n` pages titled "Page i", inserted in bulk. */
		const seedPages = async (t: ReturnType<typeof convexTest>, as: As & { userId: Id<"users"> }, n: number) => {
			const workspaceId = await workspaceOf(as);
			return t.run(async (ctx) => {
				const ids: Id<"pages">[] = [];
				for (let i = 0; i < n; i++) ids.push(await ctx.db.insert("pages", { workspaceId, title: `Page ${i}`, archived: false, createdBy: as.userId, updatedAt: 0, updatedBy: as.userId }));
				return ids;
			});
		};
		/** One reply holding a call per input, as the runner saves them. */
		const holdAll = async (t: ReturnType<typeof convexTest>, as: As, inputs: object[]) => {
			const { companybot } = await agentsOf(as);
			const turnId = await agentTurn(t, as, (await generalOf(as))._id, companybot._id);
			const parts = [];
			for (const [i, input] of inputs.entries()) {
				const { approvalId } = await t.mutation(internal.approvals.request, { turnId, callId: `c${i}`, tool: "pages.write", input: canonicalJson(input), risk: "inside" });
				parts.push({ type: "approval" as const, id: `c${i}`, approvalId, tool: "pages.write" });
			}
			await t.mutation(internal.turns.updateReply, { turnId, text: "", parts });
			await t.mutation(internal.turns.finishReply, { turnId });
			return as.query(api.approvals.forReply, { replyId: (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId! });
		};

		it("names the first 20 ids in a long list and counts the rest", async () => {
			const { t, member } = await ownerAndMember();
			const pages = await seedPages(t, member, 300);
			const [card] = await holdAll(t, member, [{ pages }]);
			const shown = card!.fields!.find((f) => f.key === "pages")!.value as string[];
			expect(shown).toEqual([...pages.slice(0, 20).map((_, i) => `Page ${i}`), "and 280 more"]);
		});

		it("loads a reply holding many cards, sharing one budget of names across them", async () => {
			const { t, member } = await ownerAndMember();
			const pages = await seedPages(t, member, 600);
			// 60 calls naming 10 pages each: more cards than a reply shows, more ids than one query names.
			const cards = await holdAll(t, member, Array.from({ length: 60 }, (_, i) => ({ pages: pages.slice(i * 10, i * 10 + 10) })));
			expect(cards).toHaveLength(50);
			const named = cards.flatMap((c) => c.fields![0]!.value as string[]).filter((v) => v.startsWith("Page "));
			expect(named).toHaveLength(200);
			// Past the budget, a list only says how many it left out.
			expect(cards.at(-1)!.fields![0]!.value).toEqual(["and 10 more"]);
		});
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

		const context = await t.mutation(internal.turns.turnContext, { turnId: next._id });
		expect(context.approval).toMatchObject({ id: approvalId, tool: call.tool, status: "approved", by: "member@co.com" });
		// The held call replays the same way whatever happens to it (prompt caching), and no message is re-asked.
		expect(context.session.turns.at(-1)).toEqual({ prompt: "Reply to this message: text Bob", steps: JSON.stringify([{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "crm_send_sms", input: call.input }] }]), answer: "" });
		expect(context.messages.some((m) => m.id === turn.triggerId)).toBe(false);

		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toEqual(call);
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
		await t.mutation(internal.approvals.finish, { approvalId, turnId: next._id, result: '{"sent":true}' });
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
		const context = await t.mutation(internal.turns.turnContext, { turnId: next._id });
		expect(context.member).toMatchObject({ userId, workspaceId: acme, owner: false });
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
		// An outside service's call (a connector's) may have landed: failed, with an unknown outcome (older apps show the error).
		await t.mutation(internal.approvals.claim, { approvalId: second.approvalId, turnId: next._id, outside: true });
		await t.mutation(internal.turns.finishReply, { turnId: next._id, error: "Timed out" });
		expect(await t.run((ctx) => ctx.db.get(second.approvalId))).toMatchObject({ status: "failed", outcome: "unknown", error: expect.stringContaining("may or may not have happened") });
		expect((await member.query(api.approvals.forReply, { replyId: second.turn.replyId! }))[0]).toMatchObject({ status: "failed", outcome: "unknown" });

		// A built-in's effect commits with its receipt, so one still running when its turn ends never happened.
		const third = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId: third.approvalId, hash: third.card.hash, approve: true, always: false });
		const last = (await turnsOf(t)).at(-1)!;
		await t.mutation(internal.approvals.claim, { approvalId: third.approvalId, turnId: last._id });
		await t.mutation(internal.turns.finishReply, { turnId: last._id, error: "Timed out" });
		expect(await t.run((ctx) => ctx.db.get(third.approvalId))).toMatchObject({ status: "failed", error: expect.stringContaining("nothing changed") });
	});

	it("tells the agent about a denial and runs nothing", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { approvalId, card } = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: false, always: false });
		const next = (await turnsOf(t)).at(-1)!;
		expect(next).toMatchObject({ status: "running", approvalId });
		expect((await t.mutation(internal.turns.turnContext, { turnId: next._id })).approval?.status).toBe("denied");
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
	});
});
