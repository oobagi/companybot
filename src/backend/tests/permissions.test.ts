import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { approvalHash, canonicalJson } from "@companybot/core";

import { type As, agentsOf, setup as ownerAndMember, meOf, generalOf, turnsOf, settle } from "./helpers";
import "./connectorFixtures";

// The tests drive turns themselves; keep scheduled model replies back.
beforeEach(() => void vi.useFakeTimers());

afterEach(() => void vi.useRealTimers());

describe("permissions", () => {
	const sms = { tool: "crm.send_sms", input: { to: "+15550100", body: "See you at 3" } };

	/** CRM installed and listed, Companybot granted it. */
	async function setup() {
		const { t, owner, member } = await ownerAndMember();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		const { workspaceId, _id: installId } = await t.run(async (ctx) => (await ctx.db.query("connectorInstalls").first())!);
		await t.mutation(internal.connectorTools.saveTools, {
			workspaceId,
			connectorId: "crm",
			installId,
			tools: [
				{ name: "send_sms", description: "Text someone", risk: "outside" },
				{ name: "find_leads", description: "Find leads", risk: "none" },
				{ name: "charge_card", title: "Charge a customer's card", description: "Charge a card", risk: "locked" },
			],
		});
		const { companybot } = await agentsOf(owner);
		await t.run((ctx) => ctx.db.patch(companybot._id, { tools: [...companybot.tools, "crm.*"] }));
		return { t, owner, member, companybot };
	}

	/** `as` asks Companybot in #general; returns the running turn (the test plays the runner). */
	async function ask(t: ReturnType<typeof convexTest>, as: As) {
		const { companybot } = await agentsOf(as);
		const chatId = (await generalOf(as))._id;
		await as.mutation(api.messages.send, { chatId, text: "@Companybot text Bob", mentions: { userIds: [], agentIds: [companybot._id] } });
		await cancelScheduled(t);
		return (await turnsOf(t)).at(-1)!;
	}
	const cancelScheduled = (t: ReturnType<typeof convexTest>) =>
		t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
		});
	const check = (t: ReturnType<typeof convexTest>, turnId: Id<"agentTurns">, action = sms.tool, risk: "none" | "outside" | "locked" = "outside") =>
		t.query(internal.permissions.check, { turnId, action, risk });

	it("asks by default, and a person's Always applies to their calls only, from the very next call", async () => {
		const { t, owner, member } = await setup();
		const turn = await ask(t, member);
		expect((await check(t, turn._id)).decision).toEqual({ type: "ask", canAlways: true });
		expect((await check(t, turn._id, "crm.find_leads", "none")).decision).toEqual({ type: "run" });

		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		const allowed = await check(t, turn._id);
		expect(allowed.decision).toEqual({ type: "run", via: "always" });
		expect(allowed.allowed).toMatchObject({ how: "always", by: await meOf(member) });

		// The owner's turn: a member's grant never reaches anyone else.
		await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		const theirs = await ask(t, owner);
		expect((await check(t, theirs._id)).decision).toEqual({ type: "ask", canAlways: true });
		await t.mutation(internal.turns.finishReply, { turnId: theirs._id });

		// Revoked: the next call asks again.
		const again = await ask(t, member);
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "ask" });
		expect((await check(t, again._id)).decision).toEqual({ type: "ask", canAlways: true });
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "never" });
		expect((await check(t, again._id)).decision).toEqual({ type: "deny", by: "person" });
		expect((await check(t, again._id, "crm.find_leads", "none")).decision).toEqual({ type: "run" });
	});

	it("lets owners lock actions for everyone, and lock wins over a person's rule", async () => {
		const { t, owner, member } = await setup();
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		await expect(member.mutation(api.permissions.setLock, { action: sms.tool, lock: "block" })).rejects.toThrow("permission");
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: "ask" });
		const turn = await ask(t, member);
		expect((await check(t, turn._id)).decision).toEqual({ type: "ask", canAlways: false });
		await expect(member.mutation(api.permissions.set, { action: sms.tool, setting: "always" })).rejects.toThrow("always asks");
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: "block" });
		expect((await check(t, turn._id)).decision).toEqual({ type: "deny", by: "owner" });
		// Owners can lock reads too (labels are the server's claim).
		await owner.mutation(api.permissions.setLock, { action: "crm.find_leads", lock: "ask" });
		expect((await check(t, turn._id, "crm.find_leads", "none")).decision).toEqual({ type: "ask", canAlways: false });
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: null });
		expect((await check(t, turn._id)).decision).toEqual({ type: "run", via: "always" });
	});

	it("never offers Always on locked actions (payments, deletes, bulk sends) unless an owner lifts it", async () => {
		const { t, owner, member } = await setup();
		await expect(member.mutation(api.permissions.set, { action: "crm.charge_card", setting: "always" })).rejects.toThrow("always asks");
		const listed = await member.query(api.permissions.actions, { connectorId: "crm" });
		// Named by the server's title when it gives one, else from the tool's name.
		expect(listed.find((a) => a.action === "crm.charge_card")).toMatchObject({ label: "Charge a customer's card", canAlways: false, result: "ask" });
		expect(listed.find((a) => a.action === "crm.send_sms")?.label).toBe("Send SMS");
		expect(listed.find((a) => a.action === "crm.send_sms")).toMatchObject({
			canAlways: true,
			alwaysText: expect.stringContaining("Always allow: agents can send SMS with the workspace's CRM without asking you first"),
		});
		await owner.mutation(api.permissions.setLock, { action: "crm.charge_card", lock: "none" });
		await member.mutation(api.permissions.set, { action: "crm.charge_card", setting: "always" });
		const turn = await ask(t, member);
		expect((await check(t, turn._id, "crm.charge_card", "locked")).decision).toEqual({ type: "run", via: "always" });
	});

	/** Holds `sms` in a member's reply, like the runner does. */
	async function hold(t: ReturnType<typeof convexTest>, as: As, risk: "outside" | "locked" = "outside") {
		const turn = await ask(t, as);
		await t.mutation(internal.turns.savePrompt, { turnId: turn._id, prompt: "Reply to this message: text Bob" });
		const approvalId = await t.mutation(internal.approvals.request, { turnId: turn._id, callId: "c1", tool: sms.tool, input: canonicalJson(sms.input), risk });
		await t.mutation(internal.turns.updateReply, { replyId: turn.replyId!, text: "", parts: [{ type: "approval", id: "c1", approvalId, tool: sms.tool }] });
		await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		const [card] = await as.query(api.approvals.forReply, { replyId: turn.replyId! });
		return { turn, approvalId, card: card! };
	}

	it("saves a rule when the card's Always allow is chosen, says plainly what it covers, and runs the call", async () => {
		const { t, owner, member } = await setup();
		const { approvalId, card, turn } = await hold(t, member);
		expect(card.ask).toBe("I'd like to send an SMS to +15550100 with the workspace's CRM.");
		expect(card.alwaysText).toContain("without asking you first");
		// Others don't get the offer.
		expect((await owner.query(api.approvals.forReply, { replyId: turn.replyId! }))[0]?.alwaysText).toBeNull();
		// Still locked to the exact call.
		const other = await approvalHash(sms.tool, { ...sms.input, body: "x" });
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: other, approve: true, always: true })).rejects.toThrow("isn't the one");
		expect(await member.query(api.permissions.mine)).toEqual([]);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: true });
		expect((await member.query(api.permissions.mine))!).toMatchObject([{ action: sms.tool, setting: "always", automation: null }]);
		const next = (await turnsOf(t)).at(-1)!;
		expect((await t.query(internal.turns.turnContext, { turnId: next._id })).approval).toMatchObject({ always: true });
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toEqual(sms);
	});

	it("doesn't offer or accept Always allow on locked actions; old apps' Approve still works", async () => {
		const { t, member } = await setup();
		const { approvalId, card } = await hold(t, member, "locked");
		expect(card.alwaysText).toBeNull();
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: true })).rejects.toThrow("isn't available");
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true });
		expect(await member.query(api.permissions.mine)).toEqual([]);
	});

	it("doesn't run an approved call that was blocked before it ran", async () => {
		const { t, owner, member } = await setup();
		const { approvalId, card } = await hold(t, member);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true });
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: "block" });
		const next = (await turnsOf(t)).at(-1)!;
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
		expect(await t.run((ctx) => ctx.db.get(approvalId))).toMatchObject({ status: "failed", error: expect.stringContaining("blocked") });
	});

	it("asks once when turning an automation on; grants cover that automation's runs only, and turning off takes them back", async () => {
		const { t, member, companybot } = await setup();
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		const listed = await member.query(api.permissions.forAutomation, { automationId: id });
		expect(listed.map((a) => [a.action, a.state, a.allowed])).toEqual([
			["crm.send_sms", "ask", false],
			["crm.charge_card", "locked", false],
		]);
		expect(listed[0]!.alwaysText).toContain("when running Follow up without asking you first");
		await member.mutation(api.permissions.allowForAutomation, { automationId: id, actions: ["crm.send_sms", "crm.charge_card"] });
		expect((await member.query(api.permissions.forAutomation, { automationId: id })).map((a) => a.allowed)).toEqual([true, false]);

		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const run = (await turnsOf(t)).at(-1)!;
		const allowed = await check(t, run._id);
		expect(allowed.decision).toEqual({ type: "run", via: "automation" });
		expect(allowed.allowed).toMatchObject({ how: "automation", automation: "Follow up" });
		expect((await check(t, run._id, "crm.charge_card", "locked")).decision).toEqual({ type: "ask", canAlways: false });
		// Never still wins over the grant.
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "never" });
		expect((await check(t, run._id)).decision).toEqual({ type: "deny", by: "person" });
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "ask" });
		await t.mutation(internal.turns.finishReply, { turnId: run._id });

		// Outside the automation, the same person is still asked.
		const plain = await ask(t, member);
		expect((await check(t, plain._id)).decision).toEqual({ type: "ask", canAlways: true });
		await t.mutation(internal.turns.finishReply, { turnId: plain._id });

		await member.mutation(api.automations.subscribe, { automationId: id, on: false });
		expect(await member.query(api.permissions.mine)).toEqual([]);
	});

	it("logs how each auto-allowed call was allowed, linked to the rule, and forgets rules on uninstall", async () => {
		const { t, owner, member } = await setup();
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		const turn = await ask(t, member);
		const { allowed } = await check(t, turn._id);
		await t.mutation(internal.activity.log, { turnId: turn._id, callId: "c1", tool: sms.tool, changes: true, input: "{}", output: "{}", allowed });
		const [entry] = await member.query(api.activity.list, {});
		expect(entry?.allowed).toMatchObject({ how: "always", by: "member@co.com", ruleStillOn: true });
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "ask" });
		expect((await member.query(api.activity.list, {}))[0]?.allowed?.ruleStillOn).toBe(false);

		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: false });
		await settle(t);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		expect(await member.query(api.permissions.mine)).toEqual([]);
	});

	it("never widens an automation's Always allow to a person-wide rule once the automation is deleted", async () => {
		const { t, member, companybot } = await setup();
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const run = (await turnsOf(t)).at(-1)!;
		const approvalId = await t.mutation(internal.approvals.request, { turnId: run._id, callId: "c1", tool: sms.tool, input: canonicalJson(sms.input), risk: "outside" });
		await t.mutation(internal.turns.updateReply, { replyId: run.replyId!, text: "", parts: [{ type: "approval", id: "c1", approvalId, tool: sms.tool }] });
		await t.mutation(internal.turns.finishReply, { turnId: run._id });
		const [card] = await member.query(api.approvals.forReply, { replyId: run.replyId! });
		expect(card!.alwaysText).toContain("when running Follow up");

		await member.mutation(api.automations.remove, { automationId: id });
		expect((await member.query(api.approvals.forReply, { replyId: run.replyId! }))[0]!.alwaysText).toBeNull();
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card!.hash, approve: true, always: true })).rejects.toThrow("isn't available");
		expect(await member.query(api.permissions.mine)).toEqual([]);
		// Allowing once still works, and a normal chat call still asks.
		await member.mutation(api.approvals.decide, { approvalId, hash: card!.hash, approve: true });
		await t.mutation(internal.turns.finishReply, { turnId: (await turnsOf(t)).at(-1)!._id });
		const plain = await ask(t, member);
		expect((await check(t, plain._id)).decision).toEqual({ type: "ask", canAlways: true });
	});

	it("forgets a removed member's rules, so rejoining starts strict", async () => {
		const { t, owner, member, companybot } = await setup();
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await member.mutation(api.permissions.allowForAutomation, { automationId: id, actions: [sms.tool] });
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		expect(await member.query(api.permissions.mine)).toHaveLength(2);
		const userId = await meOf(member);
		const row = (await owner.query(api.workspace.team))!.members.find((m) => m.userId === userId)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("permissionRules").collect())).toEqual([]);
	});

	it("hides creator-only automations' actions from others, and refuses their grants", async () => {
		const { t, owner, member, companybot } = await setup();
		const config = { name: "Private", prompt: "Text my leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		expect(await member.query(api.permissions.forAutomation, { automationId: id })).not.toEqual([]);
		expect(await owner.query(api.permissions.forAutomation, { automationId: id })).toEqual([]);
		await expect(owner.mutation(api.permissions.allowForAutomation, { automationId: id, actions: [sms.tool] })).rejects.toThrow("not found");
		expect(await t.run((ctx) => ctx.db.query("permissionRules").collect())).toEqual([]);
	});

	it("only offers an automation the tools its agent is granted, not the whole connector", async () => {
		const { t, member, companybot } = await setup();
		await t.run((ctx) => ctx.db.patch(companybot._id, { tools: [...companybot.tools.filter((x) => x !== "crm.*"), sms.tool] }));
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		expect((await member.query(api.permissions.forAutomation, { automationId: id })).map((a) => a.action)).toEqual([sms.tool]);
		await member.mutation(api.permissions.allowForAutomation, { automationId: id, actions: [sms.tool, "crm.charge_card"] });
		expect((await member.query(api.permissions.mine))!.map((r) => r.action)).toEqual([sms.tool]);
	});
});
