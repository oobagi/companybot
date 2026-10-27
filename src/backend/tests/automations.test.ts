import { seedAutomation } from "./legacyFixtures";
import "./connectorFixtures";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

import { signIn, agentsOf, setup as ownerAndMember, meOf, generalOf, turnsOf, settle } from "./helpers";

afterEach(() => void vi.useRealTimers());

describe("automations", () => {
	beforeEach(() => void vi.useFakeTimers());
	const tz = "America/Los_Angeles";
	type As = Awaited<ReturnType<typeof signIn>>;
	/** Who wrote each message in this person's DM with the agent, and which automation sent it. */
	const dmWith = async (as: As, agentId: Id<"agents">) => {
		const dmId = (await as.query(api.chats.list))?.agents.find((a) => a._id === agentId)?.dmId;
		const messages = dmId ? await as.query(api.messages.list, { chatId: dmId }) : [];
		return messages.map((m) => [m.author.type, m.automation?.name ?? null]);
	};
	const find = async (as: As, id: string) => (await as.query(api.automations.list)).find((a) => a.id === id);
	/** Runs the scheduler on a Thursday 10am in LA, with every schedule due. */
	async function tickThursday(t: ReturnType<typeof convexTest>) {
		await t.run(async (ctx) => {
			for (const install of await ctx.db.query("automationInstalls").collect()) await ctx.db.patch(install._id, { lastRunDate: "2000-01-01" });
		});
		await t.mutation(internal.automationRuns.tick, { now: Date.UTC(2026, 9, 22, 17) });
	}
	const install = seedAutomation;

	it("runs and cleans up through automationRuns", async () => {
		vi.useFakeTimers();
		const { t, owner } = await ownerAndMember();
		await install(t, owner, "morning-brief");
		await owner.mutation(api.automationRuns.runNow, { automationId: "morning-brief" });
		const { companybot } = await agentsOf(owner);
		expect(await dmWith(owner, companybot._id)).toEqual([["user", "Morning brief"], ["agent", null]]);
		await t.mutation(internal.automationRuns.forgetOldWebhooks, {});
		await t.mutation(internal.automationRuns.tick, { now: 0 });
	});

	describe("library", () => {
		it("refuses library installation from old desktops and keeps existing opt-ins", async () => {
			const { t, owner, member } = await ownerAndMember();
			await expect(member.mutation(api.automations.setInstalled, { automationId: "morning-brief", installed: true, timeZone: tz })).rejects.toThrow("permission");
			await expect(owner.mutation(api.automations.setInstalled, { automationId: "morning-brief", installed: true, timeZone: tz })).rejects.toThrow("retired");
			await install(t, owner, "morning-brief");
			expect((await find(owner, "morning-brief"))!.subscribed).toBe(true);
			expect((await find(member, "morning-brief"))!.subscribed).toBe(false);
		});

		it("runs a schedule only for people who turned it on", async () => {
			const { t, owner, member } = await ownerAndMember();
			await install(t, owner, "morning-brief");
			await tickThursday(t);
			const { companybot } = await agentsOf(member);
			expect(await dmWith(member, companybot._id)).toHaveLength(0);
			expect(await dmWith(owner, companybot._id)).toEqual([
				["user", "Morning brief"],
				["agent", null],
			]);

			await member.mutation(api.automations.subscribe, { automationId: "morning-brief", on: true });
			await tickThursday(t);
			expect(await dmWith(member, companybot._id)).toHaveLength(2);
			expect((await find(owner, "morning-brief"))!.lastResult).toBe("Sent to 2 people.");
			await member.mutation(api.automations.subscribe, { automationId: "morning-brief", on: false });
			expect((await find(member, "morning-brief"))!.subscribed).toBe(false);
		});

		it("posts once in a channel when an owner picks one; members can't change it", async () => {
			const { t, owner, member } = await ownerAndMember();
			await install(t, owner, "morning-brief");
			const sales = await owner.mutation(api.chats.createChannel, { name: "sales", private: false });
			const toSales = { automationId: "morning-brief", audience: "channel" as const, channelId: sales };
			await expect(member.mutation(api.automations.update, toSales)).rejects.toThrow("permission");
			await owner.mutation(api.automations.update, toSales);
			await expect(member.mutation(api.automations.subscribe, { automationId: "morning-brief", on: true })).rejects.toThrow(
				"isn't one people turn on",
			);
			await tickThursday(t);
			const messages = await member.query(api.messages.list, { chatId: sales });
			expect(messages.map((m) => [m.author.type, m.author.name, m.automation?.name ?? null])).toEqual([
				["user", "owner@co.com", "Morning brief"],
				["agent", "Companybot", null],
			]);
			const brief = (await find(owner, "morning-brief"))!;
			expect([brief.lastResult, brief.runsFor]).toEqual(["Posted in #sales.", "Posts once in #sales"]);
		});

		it("changes audiences explicitly between a channel and subscribers", async () => {
			const { t, owner } = await ownerAndMember();
			await install(t, owner, "morning-brief");
			const sales = await owner.mutation(api.chats.createChannel, { name: "sales", private: false });
			await owner.mutation(api.automations.update, { automationId: "morning-brief", audience: "channel", channelId: sales });
			expect((await find(owner, "morning-brief"))!.audience).toBe("channel");
			await owner.mutation(api.automations.update, { automationId: "morning-brief", audience: "subscribers" });
			expect((await find(owner, "morning-brief"))!.audience).toBe("subscribers");
		});

		it("runs now just for the person who clicked, if they can change it", async () => {
			const { t, owner, member } = await ownerAndMember();
			await install(t, owner, "morning-brief");
			await owner.mutation(api.automations.update, { automationId: "morning-brief", enabled: false });
			await owner.mutation(api.automationRuns.runNow, { automationId: "morning-brief" });
			const { companybot } = await agentsOf(owner);
			expect(await dmWith(owner, companybot._id)).toHaveLength(2);
			await expect(member.mutation(api.automationRuns.runNow, { automationId: "morning-brief" })).rejects.toThrow("permission");
		});
	});

	describe("webhooks", () => {
		const call = (id: string, extra: object = {}) =>
			JSON.stringify({ event: "call.ended", id, data: { summary: "Leaky water heater." }, ...extra });

		async function installed() {
			const ctx = await ownerAndMember();
			await install(ctx.t, ctx.owner, "after-call-summary");
			const url = (await find(ctx.owner, "after-call-summary"))!.webhookUrl!;
			const post = async (body: string, path = new URL(url, "http://x").pathname) => {
				const res = await ctx.t.fetch(path, { method: "POST", body });
				return [res.status, ((await res.json()) as { message: string }).message] as const;
			};
			return { ...ctx, url, post };
		}

		it("shows the secret URL only to people who can change it, and resets it", async () => {
			const { owner, member, url, post } = await installed();
			expect(url).toMatch(/\/automations\/[0-9a-f]{48}$/);
			expect((await find(member, "after-call-summary"))!.webhookUrl).toBeNull();
			await expect(member.mutation(api.automations.resetWebhook, { automationId: "after-call-summary" })).rejects.toThrow(
				"permission",
			);
			await owner.mutation(api.automations.resetWebhook, { automationId: "after-call-summary" });
			expect((await find(owner, "after-call-summary"))!.webhookUrl).not.toBe(url);
			expect(await post(call("1"))).toEqual([404, "Unknown webhook URL."]);
		});

		it("runs for the person named only if they turned it on, once per event id, with its data", async () => {
			const { member, post } = await installed();
			const named = { person: { email: "MEMBER@co.com" } };
			expect(await post(call("c1", named))).toEqual([200, "Didn't run: the person it's for hasn't turned it on."]);
			await member.mutation(api.automations.subscribe, { automationId: "after-call-summary", on: true });
			expect(await post(call("c2", named))).toEqual([200, "Sent to 1 person."]);
			expect(await post(call("c2", named))).toEqual([200, "Already received."]);
			const { companybot } = await agentsOf(member);
			expect(await dmWith(member, companybot._id)).toEqual([
				["user", "After-call summary"],
				["agent", null],
			]);
			const dmId = (await member.query(api.chats.list))!.agents.find((a) => a._id === companybot._id)!.dmId!;
			expect((await member.query(api.messages.list, { chatId: dmId }))[0]!.text).toContain("Leaky water heater.");
			expect(await post(call("c3", { person: { email: "nobody@co.com" } }))).toEqual([
				200,
				"Didn't run: nobody here has the email nobody@co.com.",
			]);
			// Naming nobody: everyone who turned it on.
			expect(await post(call("c4"))).toEqual([200, "Sent to 2 people."]);
		});

		it("posts in the channel when one is picked", async () => {
			const { owner, member, post } = await installed();
			const calls = await owner.mutation(api.chats.createChannel, { name: "calls", private: false });
			await owner.mutation(api.automations.update, { automationId: "after-call-summary", audience: "channel", channelId: calls });
			expect(await post(call("c1"))).toEqual([200, "Posted in #calls."]);
			expect(await member.query(api.messages.list, { chatId: calls })).toHaveLength(2);
		});

		it("forgets event ids after a week and on purge, preserving them through Trash", async () => {
			const { t, owner, post } = await installed();
			await post(call("old"));
			const events = () => t.run((ctx) => ctx.db.query("automationEvents").collect());
			const now = Date.now();
			vi.setSystemTime(now + 8 * 24 * 60 * 60 * 1000);
			try {
				await post(call("new"));
				await t.mutation(internal.automationRuns.forgetOldWebhooks);
			} finally {
				vi.setSystemTime(now);
			}
			expect((await events()).map((e) => e.eventId)).toEqual(["new"]);
			await owner.mutation(api.automations.remove, { automationId: "after-call-summary" });
			const trash = (await find(owner, "after-call-summary"))!.trash!;
			expect(await events()).toHaveLength(1);
			expect((await post(call("new")))[0]).toBe(404);
			await owner.mutation(api.trash.restore, { kind: "automation", id: trash.itemId });
			expect(await post(call("new"))).toEqual([200, "Already received."]);
			await owner.mutation(api.automations.remove, { automationId: "after-call-summary" });
			await owner.mutation(api.trash.purge, { id: trash.itemId });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await events()).toHaveLength(0);
		});

		it("refuses bad bodies and skips when turned off", async () => {
			const { owner, post } = await installed();
			expect(await post("nope")).toEqual([400, "Body isn't JSON."]);
			expect(await post(JSON.stringify({ event: "call.started", id: "1" }))).toEqual([400, "This URL takes call.ended events."]);
			expect(await post(JSON.stringify({ event: "call.ended" }))).toEqual([400, "id must be a string of 1-200 characters."]);
			expect(await post(call("1"), "/automations/wrong")).toEqual([404, "Unknown webhook URL."]);
			expect(await post(call("1".repeat(40_000)))).toEqual([413, "Body is over 32 KB."]);
			await owner.mutation(api.automations.update, { automationId: "after-call-summary", enabled: false });
			expect(await post(call("1"))).toEqual([200, "Not run: the automation is off."]);
		});
	});

	describe("made by anyone", () => {
		const daily = { type: "schedule" as const, time: "09:00", weekdays: [5, 1, 2, 3, 4] };
		async function make(as: As, config: { name: string; prompt: string; trigger: unknown }, audience: "creator" | "subscribers" | "channel" = "creator", channelId?: Id<"chats">) {
			const { companybot } = await agentsOf(as);
			return as.mutation(api.automations.create, {
				config: config as never,
				agentId: companybot._id,
				audience,
				channelId,
				timeZone: tz,
			});
		}

		it("lets members make their own, private to them, and checks what they wrote", async () => {
			const { t, owner, member } = await ownerAndMember();
			const id = await make(member, { name: "Standup", prompt: "Ask what I'm on today.", trigger: daily });
			expect(await find(owner, id)).toBeUndefined();
			const mine = (await find(member, id))!;
			expect(mine).toMatchObject({ name: "Standup", publisher: "Your team", trigger: "Weekdays at 9:00 AM", audience: "creator", canEdit: true });
			expect(mine.custom).toMatchObject({ version: 1, trigger: { weekdays: [1, 2, 3, 4, 5] } });
			await expect(make(member, { name: " ", prompt: "y", trigger: daily })).rejects.toThrow("Give it a name.");
			await expect(make(member, { name: "x", prompt: "", trigger: daily })).rejects.toThrow("Say what the agent should do.");
			await expect(make(member, { name: "x", prompt: "y", trigger: { ...daily, time: "25:00" } })).rejects.toThrow("Pick a time.");
			await expect(make(member, { name: "x", prompt: "y", trigger: { ...daily, weekdays: [] } })).rejects.toThrow("Pick at least one day.");

			await tickThursday(t);
			const { companybot } = await agentsOf(member);
			expect(await dmWith(member, companybot._id)).toEqual([
				["user", "Standup"],
				["agent", null],
			]);
			expect(await dmWith(owner, companybot._id)).toHaveLength(0);
		});

		it("lets an owner rename one watching a channel they're not in, but not make it just for them", async () => {
			const { t, owner, member } = await ownerAndMember();
			const ops = await member.mutation(api.chats.createChannel, { name: "ops", private: true });
			const { companybot } = await agentsOf(member);
			const config = { name: "Ops log", prompt: "Log it.", trigger: { type: "event" as const, event: "message.posted" as const, channelId: ops } };
			const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: tz });
			await owner.mutation(api.automations.save, { automationId: id, config: { ...config, name: "Ops diary" }, expectedVersion: 1 });
			await expect(owner.mutation(api.automations.update, { automationId: id, audience: "creator" })).rejects.toThrow(
				"Only the person who made it can make it just for them.",
			);
			// Turning it into a schedule after today's time starts tomorrow, not on the next tick.
			const schedule = { type: "schedule" as const, time: "00:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };
			await member.mutation(api.automations.save, { automationId: id, config: { ...config, trigger: schedule }, expectedVersion: 2 });
			await t.mutation(internal.automationRuns.tick, {});
			expect((await find(member, id))!.lastRunAt).toBeNull();
		});

		it("lets the creator or an owner change it, nobody else", async () => {
			const { t, owner, member } = await ownerAndMember();
			await owner.mutation(api.workspace.invite, { email: "other@co.com", role: "member" });
			const other = await signIn(t, "other@co.com");
			const id = await make(member, { name: "Leads", prompt: "Post the lead.", trigger: daily }, "subscribers");
			const config = { name: "  New leads  ", prompt: "  Post the lead.  ", trigger: { type: "webhook" as const } };
			await expect(other.mutation(api.automations.save, { automationId: id, config, expectedVersion: 1 })).rejects.toThrow("Only the person who made");
			expect((await find(other, id))!.canEdit).toBe(false);
			await owner.mutation(api.automations.save, { automationId: id, config, expectedVersion: 1 });
			await expect(member.mutation(api.automations.save, { automationId: id, config: { ...config, name: "" }, expectedVersion: 1 })).rejects.toThrow("Someone else saved a change");
			await expect(member.mutation(api.automations.save, { automationId: id, config: { ...config, name: "" }, expectedVersion: 2 })).rejects.toThrow("Give it a name.");
			const saved = (await find(member, id))!;
			expect([saved.name, saved.trigger, saved.custom!.version]).toEqual(["New leads", "When another app sends a webhook", 2]);
			expect(saved.custom).toMatchObject({ prompt: "Post the lead.", updatedByName: "owner@co.com", updatedAt: expect.any(Number) });
			expect(saved.createdByName).toBe("member@co.com");
			expect(saved.webhookUrl).toMatch(/\/automations\/[0-9a-f]{48}$/);
			await member.mutation(api.automations.save, { automationId: id, config: { ...config, trigger: daily }, expectedVersion: 2 });
			expect((await find(member, id))!.webhookUrl).toBeNull();
			await expect(other.mutation(api.automations.remove, { automationId: id })).rejects.toThrow(
				"Only the person who made",
			);
			await member.mutation(api.automations.remove, { automationId: id });
			expect((await find(member, id))!.trash).toMatchObject({ kind: "automation", user: "member@co.com", canRestore: true });
		});

		it("runs nothing from Trash, and runs again once restored", async () => {
			const { t, member } = await ownerAndMember();
			const id = await make(member, { name: "Standup", prompt: "Ask for updates.", trigger: daily }, "creator");
			const { companybot } = await agentsOf(member);
			await member.mutation(api.automations.remove, { automationId: id });
			await tickThursday(t);
			expect(await dmWith(member, companybot._id)).toHaveLength(0);
			const [entry] = (await member.query(api.trash.list, { kind: "automation", paginationOpts: { numItems: 10, cursor: null } })).page;
			await member.mutation(api.trash.restore, { kind: "automation", id: entry!.itemId });
			await tickThursday(t);
			expect(await dmWith(member, companybot._id)).toHaveLength(2);
		});

		it("removes custom automations and related rows", async () => {
			const { t, owner, member } = await ownerAndMember();
			await owner.mutation(api.workspace.invite, { email: "other@co.com", role: "member" });
			const other = await signIn(t, "other@co.com");
			const id = await make(member, { name: "Forms", prompt: "Post it.", trigger: { type: "webhook" } }, "subscribers");
			const path = new URL((await find(member, id))!.webhookUrl!, "http://x").pathname;
			await t.fetch(path, { method: "POST", body: JSON.stringify({ id: "delivery-1" }) });
			await other.mutation(api.automations.subscribe, { automationId: id, on: true });
			const remove = (as: typeof owner) => as.mutation(api.automations.remove, { automationId: id });
			await expect(remove(other)).rejects.toThrow("Only the person who made");
			expect(await find(member, id)).toBeDefined();
			await remove(member);
			await remove(member);
			// In Trash: nothing triggers it and nobody can change it; its opt-ins wait for a restore.
			expect((await find(member, id))!.trash).toMatchObject({ kind: "automation", canRestore: true });
			expect((await t.fetch(path, { method: "POST", body: JSON.stringify({ id: "delivery-2" }) })).status).toBe(404);
			await expect(member.mutation(api.automations.save, { automationId: id, config: { name: "X", prompt: "Y", trigger: { type: "webhook" } }, expectedVersion: 1 })).rejects.toThrow("Automation not found.");
			const [entry] = (await other.query(api.trash.list, { paginationOpts: { numItems: 10, cursor: null } })).page;
			expect(entry).toMatchObject({ kind: "automation", name: "Forms", screenId: id, canRestore: false });
			await expect(other.mutation(api.trash.restore, { kind: "automation", id: entry!.itemId })).rejects.toThrow("Only the person who made");
			await member.mutation(api.trash.restore, { kind: "automation", id: entry!.itemId });
			expect(await find(member, id)).toMatchObject({ trash: null, subscriberCount: 2 });
			await remove(member);
			await owner.mutation(api.trash.purge, { id: entry!.itemId });
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await find(member, id)).toBeUndefined();
			const rows = await t.run(async (ctx) => ({
				installs: await ctx.db.query("automationInstalls").collect(),
				subscriptions: await ctx.db.query("automationSubscriptions").collect(),
				deliveries: await ctx.db.query("automationEvents").collect(),
			}));
			expect(rows).toEqual({ installs: [], subscriptions: [], deliveries: [] });
			expect((await t.fetch(path, { method: "POST", body: JSON.stringify({ id: "delivery-2" }) })).status).toBe(404);
			const shared = await make(member, { name: "Shared", prompt: "Ask.", trigger: daily }, "subscribers");
			await owner.mutation(api.automations.remove, { automationId: shared });
			expect((await find(member, shared))!.trash).toMatchObject({ user: "owner@co.com" });
		});

		it("trashes and restores retained library automations with their opt-ins", async () => {
			const { t, owner, member } = await ownerAndMember();
			await install(t, owner, "morning-brief");
			await expect(member.mutation(api.automations.remove, { automationId: "morning-brief" })).rejects.toThrow("permission");
			await owner.mutation(api.automations.remove, { automationId: "morning-brief" });
			await owner.mutation(api.automations.remove, { automationId: "morning-brief" });
			const trashed = (await find(owner, "morning-brief"))!;
			expect(trashed.trash).toMatchObject({ kind: "automation", canRestore: true });
			await expect(owner.mutation(api.automationRuns.runNow, { automationId: "morning-brief" })).rejects.toThrow();
			await owner.mutation(api.trash.restore, { kind: "automation", id: trashed.trash!.itemId });
			expect(await find(owner, "morning-brief")).toMatchObject({ trash: null, subscribed: true, subscriberCount: 1 });
			await owner.mutation(api.automations.remove, { automationId: "morning-brief" });
			await owner.mutation(api.trash.purge, { id: trashed.trash!.itemId });
			await settle(t);
			expect(await t.run((ctx) => ctx.db.query("automationSubscriptions").collect())).toHaveLength(0);
			await expect(owner.mutation(api.automations.setInstalled, { automationId: "morning-brief", installed: true })).rejects.toThrow("retired");
		});

		it("takes any webhook body when it has no named event", async () => {
			const { t, owner } = await ownerAndMember();
			const sales = await owner.mutation(api.chats.createChannel, { name: "sales", private: false });
			const id = await make(owner, { name: "Forms", prompt: "Post the form.", trigger: { type: "webhook" } }, "channel", sales);
			const path = new URL((await find(owner, id))!.webhookUrl!, "http://x").pathname;
			const post = async (body: object) => (await t.fetch(path, { method: "POST", body: JSON.stringify(body) })).status;
			expect(await post({ id: "f1", data: { email: "a@b.com" } })).toBe(200);
			expect(await post({ event: "form.submitted", id: "f2" })).toBe(200);
			const posted = (await owner.query(api.messages.list, { chatId: sales })).filter((m) => m.automation);
			expect(posted.map((m) => m.automation!.name)).toEqual(["Forms", "Forms"]);
		});
	});

	describe("from chat", () => {
		it("lets an agent set one up for the person it's helping, with their rules", async () => {
			const { t, owner, member } = await ownerAndMember();
			const { companybot } = await agentsOf(owner);
			await owner.mutation(api.chats.createChannel, { name: "board", private: true });
			await member.mutation(api.messages.send, {
				chatId: (await generalOf(member))._id,
				text: "@Companybot every Monday send me quiet deals",
				mentions: { userIds: [], agentIds: [companybot._id] },
			});
			const turnId = (await turnsOf(t))[0]!._id;
			const create = (input: object) => t.mutation(internal.automationTools.createFor, { turnId, input });
			const weekly = { name: "Quiet deals", prompt: "List deals with no activity in 2 weeks.", trigger: { type: "schedule", time: "09:00", days: ["mon"] } };

			const made = await create({ ...weekly, runsFor: "me" });
			expect(made).toMatchObject({ name: "Quiet deals", when: "Mon at 9:00 AM (UTC)", runsFor: "Just member@co.com, in their chat with the agent" });
			const listed = await t.query(internal.automationTools.listFor, { turnId });
			expect(listed).toEqual([expect.objectContaining({ name: "Quiet deals", madeByYou: true, onForYou: null })]);
			expect(await create({ ...weekly, runsFor: "#board" })).toEqual({ error: "There's no channel #board they can see." });
			expect(await create({ ...weekly, runsFor: "everyone" })).toEqual({ error: 'runsFor must be "me", "anyone", or a channel like "#sales".' });
			expect(await create({ ...weekly, name: "" })).toEqual({ error: "Give it a name." });
			const hook = await create({ name: "Forms", prompt: "Post it.", trigger: { type: "webhook" }, runsFor: "me" });
			expect(hook).toMatchObject({ webhookUrl: expect.stringMatching(/\/automations\/[0-9a-f]{48}$/) });

			await install(t, owner, "morning-brief");
			expect(await t.mutation(internal.automationTools.setMineFor, { turnId, id: "morning-brief", on: true })).toEqual({ id: "morning-brief", on: true });
			expect((await find(member, "morning-brief"))!.subscribed).toBe(true);
		});
	});

	describe("in-app events", () => {
		it("replies in the thread of a message posted in the channel it watches", async () => {
			const { owner, member } = await ownerAndMember();
			const support = await owner.mutation(api.chats.createChannel, { name: "support", private: false });
			const other = await owner.mutation(api.chats.createChannel, { name: "random", private: false });
			const { companybot } = await agentsOf(owner);
			await owner.mutation(api.automations.create, {
				config: { name: "Triage", prompt: "Tag the request.", trigger: { type: "event", event: "message.posted", channelId: support } },
				agentId: companybot._id,
				audience: "channel",
				channelId: support,
				timeZone: tz,
			});
			expect((await find(owner, (await owner.query(api.automations.list))[0]!.id))!.trigger).toBe("When someone posts in #support");
			const send = (chatId: Id<"chats">, text: string) =>
				member.mutation(api.messages.send, { chatId, text, mentions: { userIds: [], agentIds: [] } });
			await send(other, "unrelated");
			const messageId = await send(support, "My invoice is wrong");
			const top = await member.query(api.messages.list, { chatId: support });
			expect(top.map((m) => m.text)).toEqual(["My invoice is wrong"]);
			const [, ...replies] = await member.query(api.messages.list, { chatId: support, threadId: messageId });
			expect(replies.map((m) => [m.author.type, m.automation?.name ?? null])).toEqual([
				["user", "Triage"],
				["agent", null],
			]);
			expect(replies[0]!.text).toContain("My invoice is wrong");
		});

		it("posts what a private channel says only back into that channel", async () => {
			const { owner } = await ownerAndMember();
			const board = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
			const general = (await generalOf(owner))._id;
			const { companybot } = await agentsOf(owner);
			const watchBoard = { name: "Relay", prompt: "Repeat it.", trigger: { type: "event" as const, event: "message.posted" as const, channelId: board } };
			const base = { config: watchBoard, agentId: companybot._id, timeZone: tz };
			await expect(owner.mutation(api.automations.create, { ...base, audience: "channel", channelId: general })).rejects.toThrow(
				"which is private, so it can only post there",
			);
			const id = await owner.mutation(api.automations.create, { ...base, audience: "subscribers" });
			await expect(owner.mutation(api.automations.update, { automationId: id, audience: "channel", channelId: general })).rejects.toThrow(
				"which is private",
			);
			await owner.mutation(api.automations.update, { automationId: id, audience: "channel", channelId: board });
		});

		it("runs ones people make only as their maker, never falling back to an owner", async () => {
			const { t, owner, member } = await ownerAndMember();
			const ops = await member.mutation(api.chats.createChannel, { name: "ops", private: true });
			await member.mutation(api.chats.addMembers, { chatId: ops, userIds: [await meOf(owner)], agentIds: [] });
			const { companybot } = await agentsOf(member);
			const id = await member.mutation(api.automations.create, {
				config: { name: "Hook", prompt: "Act on it.", trigger: { type: "webhook" } },
				agentId: companybot._id,
				audience: "channel",
				channelId: ops,
				timeZone: tz,
			});
			const token = (await find(member, id))!.webhookUrl!.split("/").at(-1)!;
			await member.mutation(api.chats.leave, { chatId: ops });
			await t.mutation(internal.automationRuns.receive, { token, body: JSON.stringify({ id: "e1", data: {} }) });
			expect((await find(member, id))!.lastResult).toBe("Didn't run: member@co.com, who made it, isn't in #ops. Pick another channel.");
			expect((await owner.query(api.messages.list, { chatId: ops })).some((m) => m.automation)).toBe(false);
		});

		it("gives people only events from chats they can see", async () => {
			const { owner, member } = await ownerAndMember();
			const board = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
			const { companybot } = await agentsOf(member);
			await expect(
				member.mutation(api.automations.create, {
					config: { name: "Spy", prompt: "x", trigger: { type: "event", event: "message.posted", channelId: board } },
					agentId: companybot._id,
					audience: "creator",
					timeZone: tz,
				}),
			).rejects.toThrow("That channel isn't available.");
			await owner.mutation(api.automations.create, {
				config: { name: "Board notes", prompt: "Note it.", trigger: { type: "event", event: "message.posted", channelId: board } },
				agentId: companybot._id,
				audience: "subscribers",
				timeZone: tz,
			});
			const id = (await owner.query(api.automations.list))[0]!.id;
			await member.mutation(api.automations.subscribe, { automationId: id, on: true });
			await owner.mutation(api.messages.send, { chatId: board, text: "Raise prices", mentions: { userIds: [], agentIds: [] } });
			expect(await dmWith(member, companybot._id)).toHaveLength(0);
			expect(await dmWith(owner, companybot._id)).toEqual([
				["user", "Board notes"],
				["agent", null],
			]);
		});

		it("runs when someone joins the workspace", async () => {
			const { t, owner } = await ownerAndMember();
			const { companybot } = await agentsOf(owner);
			await owner.mutation(api.automations.create, {
				config: { name: "Welcome", prompt: "Welcome them.", trigger: { type: "event", event: "member.joined" } },
				agentId: companybot._id,
				audience: "creator",
				timeZone: tz,
			});
			await owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
			await signIn(t, "new@co.com");
			expect(await dmWith(owner, companybot._id)).toEqual([
				["user", "Welcome"],
				["agent", null],
			]);
		});
	});
});
