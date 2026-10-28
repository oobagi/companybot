import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { approvalHash, canonicalJson, findConnector, openConnector, toolApprovalPolicy, toolRisk } from "@companybot/core";

import { type As, agentsOf, setup as ownerAndMember, meOf, generalOf, turnsOf, settle } from "./helpers";
import "./connectorFixtures";
import { fakeMcpServer } from "../../core/test/test-mcp-server";

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
		const tools = [...companybot.tools.filter(g => !["automations.*", "skills.remove", "members.*"].includes(g)), "crm.*"];
		await t.run((ctx) => ctx.db.patch(companybot._id, { tools }));
		return { t, owner, member, companybot: { ...companybot, tools } };
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
	const check = (t: ReturnType<typeof convexTest>, turnId: Id<"agentTurns">, action = sms.tool, risk: "none" | "inside" | "outside" | "locked" = "outside") =>
		t.query(internal.permissions.check, { turnId, action, risk });

	/** Consent is saved by deciding an exact held call, never at turn-on. */
	async function allowCall(t: ReturnType<typeof convexTest>, as: As, turn: Awaited<ReturnType<typeof ask>>, tool = sms.tool, risk: "inside" | "outside" = "outside") {
		const { approvalId } = await t.mutation(internal.approvals.request, { turnId: turn._id, callId: "grant", tool, input: "{}", risk });
		const row = (await t.run(ctx => ctx.db.get(approvalId)))!;
		await as.mutation(api.approvals.decide, { approvalId, hash: row.hash, approve: true, always: true });
		await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		await t.mutation(internal.turns.finishReply, { turnId: (await turnsOf(t)).at(-1)!._id });
		return approvalId;
	}

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
		const { approvalId } = await t.mutation(internal.approvals.request, { turnId: turn._id, callId: "c1", tool: sms.tool, input: canonicalJson(sms.input), risk });
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

	it("doesn't offer or accept Always allow on locked actions; Allow once still works", async () => {
		const { t, member } = await setup();
		const { approvalId, card } = await hold(t, member, "locked");
		expect(card.alwaysText).toBeNull();
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: true })).rejects.toThrow("isn't available");
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false });
		expect(await member.query(api.permissions.mine)).toEqual([]);
	});

	it("keeps unbackfilled approvals conservative: no Always grant, and later blocks still win", async () => {
		const { t, owner, member } = await setup();
		const { approvalId, card, turn } = await hold(t, member);
		// The alpha.6 migrations never populated risk on older stored approvals.
		await t.run(ctx => ctx.db.patch(approvalId, { risk: undefined }));
		expect((await member.query(api.approvals.forReply, { replyId: turn.replyId! }))[0]?.alwaysText).toBeNull();
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: true })).rejects.toThrow("isn't available");
		expect(await member.query(api.permissions.mine)).toEqual([]);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false });
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: "block" });
		const next = (await turnsOf(t)).at(-1)!;
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
		expect(await t.run(ctx => ctx.db.get(approvalId))).toMatchObject({ status: "failed", error: expect.stringContaining("blocked") });
	});

	it("doesn't run an approved call that was blocked before it ran", async () => {
		const { t, owner, member } = await setup();
		const { approvalId, card } = await hold(t, member);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: false });
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: "block" });
		const next = (await turnsOf(t)).at(-1)!;
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
		expect(await t.run((ctx) => ctx.db.get(approvalId))).toMatchObject({ status: "failed", error: expect.stringContaining("blocked") });
	});

	it("asks at first use; Always covers only that automation, and turning off takes it back", async () => {
		const { t, member, companybot } = await setup();
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });

		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const run = (await turnsOf(t)).at(-1)!;
		expect((await check(t, run._id)).decision).toMatchObject({ type: "ask", canAlways: true });
		await allowCall(t, member, run);
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const later = (await turnsOf(t)).at(-1)!;
		const allowed = await check(t, later._id);
		expect(allowed.decision).toEqual({ type: "run", via: "automation" });
		expect(allowed.allowed).toMatchObject({ how: "automation", automation: "Follow up" });
		// In an automation's run, only the held call waits for the person; the run goes on.
		expect((await check(t, later._id, "crm.charge_card", "locked")).decision).toEqual({ type: "ask", canAlways: false, waitFor: "member@co.com" });
		// Never still wins over the grant.
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "never" });
		expect((await check(t, later._id)).decision).toEqual({ type: "deny", by: "person" });
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "ask" });
		await t.mutation(internal.turns.finishReply, { turnId: later._id });

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
		const { approvalId } = await t.mutation(internal.approvals.request, { turnId: run._id, callId: "c1", tool: sms.tool, input: canonicalJson(sms.input), risk: "outside" });
		await t.mutation(internal.turns.updateReply, { replyId: run.replyId!, text: "", parts: [{ type: "approval", id: "c1", approvalId, tool: sms.tool }] });
		await t.mutation(internal.turns.finishReply, { turnId: run._id });
		const [card] = await member.query(api.approvals.forReply, { replyId: run.replyId! });
		expect(card!.alwaysText).toContain("when running Follow up");

		await member.mutation(api.automations.remove, { automationId: id });
		expect((await member.query(api.approvals.forReply, { replyId: run.replyId! }))[0]!.alwaysText).toBeNull();
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card!.hash, approve: true, always: true })).rejects.toThrow("isn't available");
		expect(await member.query(api.permissions.mine)).toEqual([]);
		// Allowing once still works, and a normal chat call still asks.
		await member.mutation(api.approvals.decide, { approvalId, hash: card!.hash, approve: true, always: false });
		await t.mutation(internal.turns.finishReply, { turnId: (await turnsOf(t)).at(-1)!._id });
		const plain = await ask(t, member);
		expect((await check(t, plain._id)).decision).toEqual({ type: "ask", canAlways: true });
	});

	it("never offers Always for a call held after its automation was deleted mid-run", async () => {
		const { t, member, companybot } = await setup();
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const run = (await turnsOf(t)).at(-1)!;
		await member.mutation(api.automations.remove, { automationId: id });
		const { approvalId } = await t.mutation(internal.approvals.request, { turnId: run._id, callId: "c1", tool: sms.tool, input: canonicalJson(sms.input), risk: "outside" });
		expect((await t.run(ctx => ctx.db.get(approvalId)))!.automationInstallId).toBeUndefined();
		const row = (await t.run(ctx => ctx.db.get(approvalId)))!;
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: row.hash, approve: true, always: true })).rejects.toThrow("isn't available");
		expect(await member.query(api.permissions.mine)).toEqual([]);
	});

	it("forgets a removed member's rules, so rejoining starts strict", async () => {
		const { t, owner, member, companybot } = await setup();
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		await allowCall(t, member, (await turnsOf(t)).at(-1)!);
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		expect(await member.query(api.permissions.mine)).toHaveLength(2);
		const userId = await meOf(member);
		const row = (await owner.query(api.workspace.team))!.members.find((m) => m.userId === userId)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("permissionRules").collect())).toEqual([]);
	});

	describe("automations someone else wrote", () => {
		const daily = { name: "Monday sales summary", prompt: "Summarize sales.", trigger: { type: "schedule" as const, time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } };

		/** Ben (the member) writes a daily automation; the owner turns it on too. One run each, as the runner would see them. */
		async function bens() {
			const { t, owner, member, companybot } = await setup();
			const id = await member.mutation(api.automations.create, { config: daily, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
			for (const as of [owner, member]) await as.mutation(api.automations.subscribe, { automationId: id, on: true });
			const runs = async () => {
				await t.run(async (ctx) => {
					const install = (await ctx.db.query("automationInstalls").collect()).find((i) => i.automationId === id)!;
					await ctx.db.patch(install._id, { lastRunDate: undefined });
				});
				for (const turn of await turnsOf(t)) if (turn.status === "running" || turn.status === "queued") await t.mutation(internal.turns.finishReply, { turnId: turn._id });
				const before = await turnsOf(t);
				await t.mutation(internal.automationRuns.tick, { now: (Math.floor(Date.now() / 86_400_000) + 2) * 86_400_000 + 10 * 3_600_000 });
				await cancelScheduled(t);
				const fresh = (await turnsOf(t)).filter((x) => !before.some((b) => b._id === x._id));
				return { owners: fresh.find((x) => x.actorId === owner.userId)!, bens: fresh.find((x) => x.actorId === member.userId)! };
			};
			return { t, owner, member, id, runs };
		}

		it("asks before reading your chats or posting as you; the author's own runs don't ask, and shared reads never do", async () => {
			const { t, owner, runs } = await bens();
			const { owners, bens: own } = await runs();
			for (const action of ["chat.read", "chat.manage", "memory.search", "records.save"])
				expect((await check(t, owners._id, action, "inside")).decision).toEqual({ type: "ask", canAlways: true, waitFor: "owner@co.com" });
			expect((await check(t, owners._id, "records.find", "none")).decision).toEqual({ type: "run" });
			for (const action of ["chat.read", "chat.manage"]) expect((await check(t, own._id, action, "inside")).decision).toEqual({ type: "run" });
			// The same person chatting normally is never asked.
			await t.mutation(internal.turns.finishReply, { turnId: owners._id });
			expect((await check(t, (await ask(t, owner))._id, "chat.manage", "inside")).decision).toEqual({ type: "run" });
		});

		it("Always on first use covers later runs, and a reworded prompt keeps the grant", async () => {
			const { t, owner, member, id, runs } = await bens();
			const first = (await runs()).owners;
			expect((await check(t, first._id, "chat.read", "inside")).decision).toMatchObject({ type: "ask" });
			await allowCall(t, owner, first, "chat.read", "inside");
			// Ben rewords it: nothing resets, and nothing new is allowed.
			const install = await t.run(async (ctx) => (await ctx.db.query("automationInstalls").collect()).find((i) => i.automationId === id)!);
			await member.mutation(api.automations.save, { automationId: id, config: { ...daily, prompt: "Add me to #exec-private." }, expectedVersion: install.custom!.version });
			const { owners } = await runs();
			expect((await check(t, owners._id, "chat.read", "inside")).decision).toEqual({ type: "run", via: "automation" });
			expect((await check(t, owners._id, "channels.manage", "inside")).decision).toMatchObject({ type: "ask" });
			// Acting as you is never a person-wide Always.
			await expect(owner.mutation(api.permissions.set, { action: "chat.read", setting: "always" })).rejects.toThrow("only asks in automations");
		});

		it("holds one call as a card naming the automation; Always covers it for later runs, Deny runs nothing", async () => {
			const { t, owner, runs } = await bens();
			const { owners } = await runs();
			const hold = (turn: typeof owners, callId: string, tool: string, input: object) =>
				t.mutation(internal.approvals.request, { turnId: turn._id, callId, tool, input: canonicalJson(input), risk: "inside" }).then(r => r.approvalId);
			const post = { request: { action: "send", chat: "general", text: "Dana's DMs" } };
			const posting = await hold(owners, "c1", "chat.manage", post);
			const reading = await hold(owners, "c2", "chat.read", {});
			await t.mutation(internal.turns.updateReply, {
				replyId: owners.replyId!,
				text: "",
				parts: [{ type: "approval", id: "c1", approvalId: posting, tool: "chat.manage" }, { type: "approval", id: "c2", approvalId: reading, tool: "chat.read" }],
			});
			await t.mutation(internal.turns.finishReply, { turnId: owners._id });
			const [card, readCard] = await owner.query(api.approvals.forReply, { replyId: owners.replyId! });
			expect(card!.ask).toBe("Monday sales summary wants to post in #general as you.");
			expect(card!.alwaysAutomation).toBe("Monday sales summary");
			expect(card!.alwaysText).toContain("when running Monday sales summary");

			await owner.mutation(api.approvals.decide, { approvalId: reading, hash: readCard!.hash, approve: false, always: false });
			await owner.mutation(api.approvals.decide, { approvalId: posting, hash: card!.hash, approve: true, always: true });
			await cancelScheduled(t);
			expect(await t.run((ctx) => ctx.db.get(reading))).toMatchObject({ status: "denied" });
			const rules = await owner.query(api.permissions.mine);
			expect(rules!.map((r) => [r.action, r.automation?.name])).toEqual([["chat.manage", "Monday sales summary"]]);
			// Later runs post without asking; the denied read still asks next time.
			const later = (await runs()).owners;
			expect((await check(t, later._id, "chat.manage", "inside")).decision).toEqual({ type: "run", via: "automation" });
			expect((await check(t, later._id, "chat.read", "inside")).decision).toMatchObject({ type: "ask" });
		});
	});

	it("asks before outside data steers a run: webhook-triggered runs ask before acting as you, even your own", async () => {
		const { t, member, companybot } = await setup();
		const config = { name: "Inbound", prompt: "File each lead.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const run = (await turnsOf(t)).at(-1)!;
		expect((await check(t, run._id, "records.save", "inside")).decision).toMatchObject({ type: "ask", canAlways: true });
	});

	it.each([false, true])("keeps channel automation cards private in the actor's DM (thread: %s), with original execution context", async thread => {
		const { t, owner, member, companybot } = await setup();
		const chatId = (await generalOf(member))._id;
		const config = { name: "Channel inbound", prompt: "Handle input.", trigger: { type: "event" as const, event: "message.posted" as const, channelId: chatId } };
		await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "channel", channelId: chatId, timeZone: "UTC" });
		await member.mutation(api.messages.send, { chatId, text: "Incoming", mentions: { userIds: [], agentIds: [] } });
		await cancelScheduled(t);
		const run = (await turnsOf(t)).at(-1)!;
		if (!thread) await t.run(ctx => ctx.db.patch(run._id, { threadId: undefined }));
		const { approvalId, separate } = await t.mutation(internal.approvals.request, {
			turnId: run._id, callId: "private", tool: "chat.read", input: canonicalJson({ chat: "private-input" }), risk: "inside",
		});
		expect(separate).toBe(true);
		const row = (await t.run(ctx => ctx.db.get(approvalId)))!;
		const reply = (await t.run(ctx => ctx.db.get(row.replyId)))!;
		expect(reply.chatId).not.toBe(chatId);
		expect(reply.parts).toMatchObject([{ type: "approval", approvalId }]);
		expect(await owner.query(api.messages.list, { chatId: reply.chatId })).toEqual([]);
		expect(await owner.query(api.approvals.forReply, { replyId: row.replyId })).toEqual([]);
		expect(await member.query(api.approvals.forReply, { replyId: run.replyId! })).toEqual([]);
		const [card] = await member.query(api.approvals.forReply, { replyId: row.replyId });
		expect(card).toMatchObject({ approver: "member@co.com", input: row.input, canDecide: true, alwaysAutomation: config.name });
		await expect(owner.mutation(api.approvals.decide, { approvalId, hash: row.hash, approve: true, always: false })).rejects.toThrow("Only member@co.com");
		await member.mutation(api.approvals.decide, { approvalId, hash: row.hash, approve: true, always: true });
		await t.mutation(internal.turns.finishReply, { turnId: run._id });
		const resumed = (await turnsOf(t)).at(-1)!;
		expect(resumed).toMatchObject({ chatId, actorId: run.actorId, triggerId: run.triggerId, approvalId });
		expect(resumed.threadId).toBe(thread ? run.threadId : undefined);
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: resumed._id })).toEqual({ tool: "chat.read", input: { chat: "private-input" } });
		expect((await check(t, resumed._id, "chat.manage", "inside")).decision).toMatchObject({ type: "ask", waitFor: "member@co.com" });
	});

	it("tracks the acting editor for agent saves and resaving old content, without trusting an already queued run", async () => {
		const { t, owner, member, companybot } = await setup();
		const config = { name: "Daily", prompt: "Summarize sales.", trigger: { type: "schedule" as const, time: "09:00", weekdays: [1] } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await t.run(ctx => ctx.db.patch(companybot._id, { tools: [...companybot.tools, "automations.manage"] }));
		const editing = await ask(t, owner);
		expect(await t.mutation(internal.manageTools.runFor, { turnId: editing._id, tool: "automations.manage", input: { request: { action: "edit", id, expectedVersion: 1, config: { ...config, prompt: "Read DMs." } } } })).toMatchObject({ done: "edit" });
		const install = await t.run(async ctx => (await ctx.db.query("automationInstalls").collect()).find(i => i.automationId === id)!);
		expect(install.custom!.updatedBy).toBe(owner.userId);
		await t.mutation(internal.turns.finishReply, { turnId: editing._id });
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const pending = (await turnsOf(t)).at(-1)!;
		expect((await check(t, pending._id, "chat.read", "inside")).decision).toMatchObject({ type: "ask" });
		await member.mutation(api.automations.save, { automationId: id, expectedVersion: 2, config });
		expect((await check(t, pending._id, "chat.read", "inside")).decision).toMatchObject({ type: "ask" });
		await t.mutation(internal.turns.finishReply, { turnId: pending._id });
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		expect((await check(t, (await turnsOf(t)).at(-1)!._id, "chat.read", "inside")).decision).toEqual({ type: "run" });
	});

	it("keeps webhook provenance after edits and deletion, including legacy messages", async () => {
		const { t, member, companybot } = await setup();
		const config = { name: "Inbound", prompt: "Handle input.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const run = (await turnsOf(t)).at(-1)!;
		await member.mutation(api.automations.save, { automationId: id, config: { ...config, trigger: { type: "schedule", time: "09:00", weekdays: [1] } }, expectedVersion: 1 });
		expect((await check(t, run._id, "chat.read", "inside")).decision).toMatchObject({ type: "ask" });
		await t.run(async ctx => {
			const trigger = (await ctx.db.get(run.triggerId))!;
			await ctx.db.patch(trigger._id, { automation: { id, name: "Inbound" } });
		});
		expect((await check(t, run._id, "chat.read", "inside")).decision).toMatchObject({ type: "ask" });
		await member.mutation(api.automations.remove, { automationId: id });
		await expect(check(t, run._id, "chat.read", "inside")).rejects.toThrow("removed");
	});

	it.each(["webhook", "event"] as const)("own %s automations ask once per action, then Always covers later runs only for that person and automation", async type => {
		const { t, owner, member, companybot } = await setup();
		const trigger = type === "webhook" ? { type } : { type, event: "member.joined" as const };
		const config = { name: "Inbound", prompt: "Handle input.", trigger };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const first = (await turnsOf(t)).at(-1)!;
		expect((await check(t, first._id, "chat.read", "inside")).decision).toMatchObject({ type: "ask" });
		await allowCall(t, member, first, "chat.read", "inside");
		await member.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		const later = (await turnsOf(t)).at(-1)!;
		expect((await check(t, later._id, "chat.read", "inside")).decision).toEqual({ type: "run", via: "automation" });
		expect((await check(t, later._id, "chat.manage", "inside")).decision).toMatchObject({ type: "ask" });
		await t.mutation(internal.turns.finishReply, { turnId: later._id });
		const otherId = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await member.mutation(api.automationRuns.runNow, { automationId: otherId });
		await cancelScheduled(t);
		const other = (await turnsOf(t)).at(-1)!;
		expect((await check(t, other._id, "chat.read", "inside")).decision).toMatchObject({ type: "ask" });
		await t.mutation(internal.turns.finishReply, { turnId: other._id });
		await owner.mutation(api.automationRuns.runNow, { automationId: id });
		await cancelScheduled(t);
		expect((await check(t, (await turnsOf(t)).at(-1)!._id, "chat.read", "inside")).decision).toMatchObject({ type: "ask" });
	});

	it("personal connector reads use runtime consent scoped to the automation, while normal chat and workspace reads stay unchanged", async () => {
		const { t, owner, member, companybot } = await setup();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: true });
		const session = await openConnector(findConnector("notes")!, { transport: fakeMcpServer([{ name: "find", readOnly: true }]) });
		try {
			const tool = session.tools[0]!;
			const risk = toolRisk(tool);
			expect(risk).toBe("inside");
			const install = (await t.run(async ctx => (await ctx.db.query("connectorInstalls").collect()).find(i => i.connectorId === "notes")))!;
			await t.mutation(internal.connectorTools.saveTools, { workspaceId: install.workspaceId, installId: install._id, connectorId: "notes", tools: [{ name: "find", description: "Read personal notes", risk }] });
			const id = await member.mutation(api.automations.create, { config: { name: "Inbound", prompt: "Read notes.", trigger: { type: "webhook" } }, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
			await member.mutation(api.automationRuns.runNow, { automationId: id });
			await cancelScheduled(t);
			const run = (await turnsOf(t)).at(-1)!;
			const call = { toolCallId: "notes", toolName: "connectors_call", input: { tool: tool.id, input: {} } };
			const policy = (turnId: Id<"agentTurns">) => toolApprovalPolicy(session.tools, async tool => (await check(t, turnId, tool.id, toolRisk(tool))).decision);
			expect(await policy(run._id)({ toolCall: call })).toMatchObject({ type: "denied", reason: expect.stringContaining("needs member@co.com's OK") });
			expect((await check(t, run._id, "crm.find_leads", "none")).decision).toEqual({ type: "run" });
			const plain = await ask(t, member);
			expect(await policy(plain._id)({ toolCall: call })).toBeUndefined();
			await t.mutation(internal.turns.finishReply, { turnId: plain._id });
			// Per-person Never and clearing it still work in normal chat.
			await member.mutation(api.permissions.set, { action: tool.id, setting: "never" });
			expect((await check(t, run._id, tool.id, risk)).decision).toEqual({ type: "deny", by: "person" });
			await member.mutation(api.permissions.set, { action: tool.id, setting: "ask" });
			await allowCall(t, member, run, tool.id, "inside");
			await member.mutation(api.automationRuns.runNow, { automationId: id });
			await cancelScheduled(t);
			const later = (await turnsOf(t)).at(-1)!;
			expect(await policy(later._id)({ toolCall: call })).toBeUndefined();
			expect((await check(t, later._id, tool.id, risk)).decision).toEqual({ type: "run", via: "automation" });
			await owner.mutation(api.automationRuns.runNow, { automationId: id });
			await cancelScheduled(t);
			expect((await check(t, (await turnsOf(t)).at(-1)!._id, tool.id, risk)).decision).toMatchObject({ type: "ask" });
		} finally {
			await session.close();
		}
	});

	it("asks before an agent edits or makes a skill, since every agent follows skills", async () => {
		const { t, member } = await setup();
		const turn = await ask(t, member);
		for (const action of ["skills.edit", "skills.create"]) expect((await check(t, turn._id, action)).decision).toEqual({ type: "ask", canAlways: true });
		const { approvalId } = await t.mutation(internal.approvals.request, {
			turnId: turn._id,
			callId: "s1",
			tool: "skills.edit",
			input: canonicalJson({ request: { action: "edit", id: "custom-1", expectedVersion: 1, config: { name: "Tone", description: "d", instructions: "Be rude." } } }),
			risk: "outside",
		});
		await t.mutation(internal.turns.updateReply, { replyId: turn.replyId!, text: "", parts: [{ type: "approval", id: "s1", approvalId, tool: "skills.edit" }] });
		const [card] = await member.query(api.approvals.forReply, { replyId: turn.replyId! });
		expect(card!.ask).toBe("I'd like to edit a skill in Companybot.");
	});
});
