import { wakeAnchor, repeatLabel } from "@companybot/core";
import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { wake } from "../convex/wakeups";
import { type As, agentTurn, agentsOf, finishQuiet, generalOf, ownerAndMember, addMember } from "./helpers";

// Wakeups (wakeups.ts): follow-ups an agent sets, and the one path from a wakeup to a quiet turn.
// See wiki/architecture.md (Automations).

type T = Awaited<ReturnType<typeof ownerAndMember>>["t"];

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

/** A running turn of Companybot for `as`, in their DM with it, and a record to talk about. */
async function setup() {
	const s = await ownerAndMember();
	const { companybot } = await agentsOf(s.member);
	const dmId = (await s.member.query(api.chats.list))!.agents.find((a) => a._id === companybot._id)!.dmId!;
	const turnId = await agentTurn(s.t, s.member, dmId, companybot._id);
	const typeId = await s.t.run(async (ctx) => (await ctx.db.query("recordTypes").collect())[0]!._id);
	const recordId = await s.member.mutation(api.records.create, { typeId, values: { name: "Acme" } });
	const record = (await s.t.run((ctx) => ctx.db.get(recordId)))!;
	return { ...s, companybot, dmId, turnId, record };
}

const create = (t: T, turnId: Id<"agentTurns">, input: object) => t.mutation(internal.wakeups.createFor, { turnId, input });
const rowOf = (t: T, id: string) => t.run((ctx) => ctx.db.get(id as Id<"wakeups">));
const turnsFor = (t: T, id: string) => t.run(async (ctx) => (await ctx.db.query("agentTurns").collect()).filter((x) => x.wakeupId === id));
const lines = (t: T) => t.run(async (ctx) => (await ctx.db.query("agentActivity").collect()).flatMap((a) => (a.wake ? [a.wake] : [])));
/** Its time comes, as the scheduler would call it. The chat turns that set it up have finished by then (one turn per place). */
async function fire(t: T, id: string) {
	await t.run(async (ctx) => {
		for (const turn of await ctx.db.query("agentTurns").collect()) if (turn.status === "running" && !turn.wakeupId) await ctx.db.patch(turn._id, { status: "done" });
	});
	const row = (await rowOf(t, id))!;
	await t.mutation(internal.wakeups.fire, { id: row._id, at: row.at! });
}
const shown = async (as: As, chatId: Id<"chats">) => (await as.query(api.messages.list, { chatId })).map((m) => [m.author.type, m.text]);

it.each([{ms: 7 * 86_400_000, repeat: {days: 7}}, {ms: 6 * 3_600_000, repeat: {hours: 6}}])("migrates numeric intervals once: $ms", async ({ms, repeat}) => {
	const {t, turnId} = await setup();
	migrationsTest.register(t);
	const {created} = await create(t, turnId, {note: "legacy", in: {days: 1}}) as {created: string};
	const id = created as Id<"wakeups">;
	await t.run(async ctx => { const row = (await ctx.db.get(id))!; await ctx.scheduler.cancel(row.scheduledId!); await ctx.db.patch(id, {every: ms, scheduledId: undefined}); });
	await t.run(async ctx => { for (const job of await ctx.db.system.query("_scheduled_functions").collect()) if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id); });
	const before = (await rowOf(t, id))!;
	await t.mutation(internal.migrations.runAll);
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(await rowOf(t, id)).toMatchObject({repeat, anchor: expect.objectContaining({local: expect.any(String), timeZone: expect.any(String)}), at: before.at, status: "pending"});
	expect((await rowOf(t, id))!.every).toBeUndefined();
	await t.mutation(internal.migrations.runAll);
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	expect((await rowOf(t, id))!.anchor).toEqual(wakeAnchor(before.at!, (await rowOf(t, id))!.anchor!.timeZone));
});

it("fires an unmigrated legacy row and carries on repeating", async () => {
	const {t, turnId, member} = await setup();
	const {created} = await create(t, turnId, {note: "old", in: {days: 1}}) as {created: string};
	await t.run(ctx => ctx.db.patch(created as Id<"wakeups">, {every: 6 * 3_600_000, repeat: undefined, anchor: undefined}));
	const before = (await rowOf(t, created))!;
	await fire(t, created);
	const after = (await rowOf(t, created))!;
	expect(after).toMatchObject({status: "pending", wakes: 1, repeat: {hours: 6}});
	expect(after.at).toBe(before.at! + 6 * 3_600_000);
	const listed = (await member.query(api.wakeups.list, {}))[0]!;
	expect(listed.repeat).toEqual({hours: 6});
	expect(listed).not.toHaveProperty("every");
	expect(repeatLabel(listed.repeat!)).toBe("every 6 hours");
 migrationsTest.register(t);
 await t.run(async ctx => {
  for (const job of await ctx.db.system.query("_scheduled_functions").collect()) if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
  const prefs = await ctx.db.query("preferences").withIndex("by_user", q => q.eq("userId", after.actorId)).unique();
  await ctx.db.patch(prefs!._id, {timeZone: "Asia/Tokyo"});
 });
 await t.mutation(internal.migrations.runAll);
 await t.finishAllScheduledFunctions(vi.runAllTimers);
 expect((await rowOf(t, created))!.anchor).toEqual(after.anchor);
});
it("a broken next-repeat calculation cannot block the current wake", async () => {
	const {t, turnId} = await setup();
	const {created} = await create(t, turnId, {note: "broken", in: {days: 1}, every: {days: 1}}) as {created: string};
	await t.run(ctx => ctx.db.patch(created as Id<"wakeups">, {anchor: {local: "invalid", timeZone: "UTC"}}));
	await fire(t, created);
	expect(await turnsFor(t, created)).toHaveLength(1);
	expect(await rowOf(t, created)).toMatchObject({status: "fired", wakes: 1, reason: "Could not schedule the next repeat."});
});
it("repeats in its original zone after the person changes zones", async () => {
	const {t, turnId} = await setup();
	const {created} = await create(t, turnId, {note: "ET", at: {year: 2027, month: 1, day: 31, hour: 9, timeZone: "America/New_York"}, every: {months: 1}}) as {created: string};
	const before = (await rowOf(t, created))!;
	expect(before.anchor).toEqual({local: "2027-01-31T09:00:00", timeZone: "America/New_York"});
	await t.run(async ctx => { const prefs = await ctx.db.query("preferences").withIndex("by_user", q => q.eq("userId", before.actorId)).unique(); await ctx.db.patch(prefs!._id, {timeZone: "Asia/Tokyo"}); });
	await fire(t, created);
	expect((await rowOf(t, created))!.at).toBe(Date.UTC(2027, 1, 28, 14));
	// Feb 28 lands on the same instant either way; Mar 31 at 9:00 EDT tells the original zone apart.
	await fire(t, created);
	expect((await rowOf(t, created))!.at).toBe(Date.UTC(2027, 2, 31, 13));
});

describe("follow-ups", () => {
	it("shows on the record, wakes the agent quietly in the same chat with the record, and logs one line", async () => {
		const { t, member, owner, dmId, turnId, record } = await setup();
		const made = await create(t, turnId, { note: "Chase the invoice if it's still unpaid.", in: {days: 3}, recordId: record._id });
		expect(made).toMatchObject({ created: expect.any(String), when: expect.stringMatching(/2026|2027/), record: record.title });
		const id = (made as { created: string }).created;

		const listed = await member.query(api.wakeups.list, { recordId: record._id });
		expect(listed).toEqual([expect.objectContaining({ _id: id, note: "Chase the invoice if it's still unpaid.", agent: "Companybot", mine: true, canCancel: true, record: expect.objectContaining({ _id: record._id }) })]);
		// Settings lists it too; an owner sees the DM's one without its note, and can cancel it.
		expect(await owner.query(api.wakeups.list, {})).toEqual([expect.objectContaining({ _id: id, note: null, place: null, canCancel: true })]);

		const before = await shown(member, dmId);
		await fire(t, id);
		const [turn] = await turnsFor(t, id);
		expect(turn).toMatchObject({ chatId: dmId, actorId: member.userId, status: "running" });
		// No trigger message, and its reply is quiet.
		expect(await shown(member, dmId)).toEqual(before);
		const context = await t.mutation(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.wake).toMatchObject({ note: "Chase the invoice if it's still unpaid.", record: { id: record._id, name: record.title } });
		expect(context.quiet).toBe(true);
		expect(context.triggerId).toBeNull();
		expect((await rowOf(t, id))!.status).toBe("fired");
		expect(await lines(t)).toEqual([expect.objectContaining({ outcome: "fired" })]);

		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });
		expect(await lines(t)).toEqual([expect.objectContaining({ outcome: "ran" })]);
		expect(await shown(member, dmId)).toEqual(before);
	});

	it("speaks up only when its decision posts: its reply is then shown, and its line says so", async () => {
		const { t, member, dmId, turnId } = await setup();
		expect((await t.mutation(internal.turns.turnContext, { turnId })).quiet).toBe(false);
		const { created } = (await create(t, turnId, { note: "Check in", in: { hours: 1 } })) as { created: string };
		await fire(t, created);
		const [turn] = await turnsFor(t, created);
		await finishQuiet(t, turn!._id, "Acme paid, nothing to chase.");
		expect((await shown(member, dmId)).at(-1)).toEqual(["agent", "Acme paid, nothing to chase."]);
		expect(await lines(t)).toEqual([expect.objectContaining({ outcome: "notified" })]);
	});

	it("runs nothing once cancelled, in the app or by the agent; only its person, whoever set it up, or someone who can change agents can", async () => {
		const { t, owner, member, turnId } = await setup();
		const one = ((await create(t, turnId, { note: "A", in: {days: 1} })) as { created: string }).created;
		const two = ((await create(t, turnId, { note: "B", in: {days: 2} })) as { created: string }).created;
		await member.mutation(api.wakeups.cancel, { id: one as Id<"wakeups"> });
		expect(await t.mutation(internal.wakeups.cancelFor, { turnId, id: two })).toEqual({ cancelled: two });
		const three = ((await create(t, turnId, { note: "C", in: {days: 3} })) as { created: string }).created;
		for (const id of [one, two]) {
			await fire(t, id);
			expect(await turnsFor(t, id)).toEqual([]);
			expect((await rowOf(t, id))!.status).toBe("cancelled");
		}
		expect((await member.query(api.wakeups.list, {})).map((w) => w._id)).toEqual([three]);

		// Someone else in the workspace: not theirs, and they can't see it.
		await owner.mutation(api.workspace.invite, { email: "other@co.com", role: "member" });
		const { signIn } = await import("./helpers");
		const other = await signIn(t, "other@co.com");
		await expect(other.mutation(api.wakeups.cancel, { id: three as Id<"wakeups"> })).rejects.toThrow("Only its person");
		await owner.mutation(api.wakeups.cancel, { id: three as Id<"wakeups"> });
		expect((await rowOf(t, three))!.reason).toBe("Cancelled by owner@co.com.");
	});

	it("checks what it's given, and caps what's pending", async () => {
		const { t, turnId, record } = await setup();
		expect(await create(t, turnId, { note: " ", in: {days: 1} })).toEqual({ error: "Say what to check when it's time." });
		expect(await create(t, turnId, { note: "x", in: { minutes: 0 } })).toEqual({ error: "Fix the time: Give a positive duration." });
		expect(await create(t, turnId, { note: "x", in: {years: 3} })).toMatchObject({ error: expect.stringMatching(/^Fix the time: years: /) });
		expect(await create(t, turnId, { note: "x", in: {days: 1}, times: 3 })).toEqual({ error: 'Give "every" with "times".' });
		expect(await create(t, turnId, { note: "x", in: {days: 1}, recordId: "nope" })).toMatchObject({ error: expect.any(String) });
		for (let i = 0; i < 10; i++) expect(await create(t, turnId, { note: `n${i}`, in: {days: 1}, recordId: record._id })).toHaveProperty("created");
		expect(await create(t, turnId, { note: "one more", in: {days: 1}, recordId: record._id })).toEqual({ error: `${record.title} already has 10 follow-ups. Cancel one first.` });
	});

	it("repeats every week for a month, then stops", async () => {
		const { t, turnId } = await setup();
		const made = await create(t, turnId, { note: "Check this deal", in: {hours: 1}, every: {weeks: 1}, times: 3 });
		expect(made).toMatchObject({ when: expect.stringMatching(/, then every week, 3 times in all$/) });
		const id = (made as { created: string }).created;
		const first = (await rowOf(t, id))!.at!;
		for (let i = 1; i <= 3; i++) {
			await fire(t, id);
			const row = (await rowOf(t, id))!;
			expect(row.wakes).toBe(i);
			expect(row.status).toBe(i < 3 ? "pending" : "fired");
			if (i < 3) expect(row.at).toBeGreaterThan(first + (i - 1) * 7 * 86_400_000);
			// Its turn finishes so the next can start in the same place.
			const turns = (await turnsFor(t, id)).filter((x) => x.status === "running");
			for (const turn of turns) {
				expect((await t.mutation(internal.turns.turnContext, {turnId: turn._id})).wake?.repeats).toEqual({left: 3 - i});
				await t.mutation(internal.turns.finishReply, { turnId: turn._id });
			}
		}
		expect(await turnsFor(t, id)).toHaveLength(3);
		const context = await t.run((ctx) => ctx.db.query("agentTurns").collect());
		expect(context.filter((x) => x.wakeupId === id)).toHaveLength(3);
	});

	it("waits while its record is in Trash, and wakes when it's restored", async () => {
		const { t, member, turnId, record } = await setup();
		const { created } = (await create(t, turnId, { note: "Ping", in: {days: 1}, recordId: record._id })) as { created: string };
		await member.mutation(api.trash.move, { kind: "record", id: record._id });
		await fire(t, created);
		expect(await turnsFor(t, created)).toEqual([]);
		expect((await rowOf(t, created))!.held).toBe(true);
		expect(await lines(t)).toEqual([expect.objectContaining({ outcome: "skipped", reason: expect.stringMatching(/^Waiting/) })]);
		await member.mutation(api.trash.restore, { kind: "record", id: record._id });
		await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
		expect(await turnsFor(t, created)).toHaveLength(1);
	});

	it("never runs as anyone else: removing the person takes theirs", async () => {
		const { t, owner, member, turnId } = await setup();
		const { created } = (await create(t, turnId, { note: "Later", in: {days: 1} })) as { created: string };
		const row = await t.run(async (ctx) => (await ctx.db.query("members").collect()).find((m) => m.userId === member.userId)!);
		// At wake time, as of now: their membership is gone before the cascade gets here.
		await t.run((ctx) => ctx.db.delete(row._id));
		await fire(t, created);
		expect(await turnsFor(t, created)).toEqual([]);
		expect(await rowOf(t, created)).toMatchObject({ status: "cancelled", reason: "Its person left the workspace." });
		await t.run((ctx) => addMember(ctx, { workspaceId: row.workspaceId, userId: member.userId, role: "member" }));
		await owner.mutation(api.workspace.removeMember, { id: (await t.run(async (ctx) => (await ctx.db.query("members").collect()).find((m) => m.userId === member.userId)!))._id });
		await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
		expect(await rowOf(t, created)).toBeNull();
	});
});

describe("trust", () => {
	it("a follow-up made in a run following others' words asks before acting as the person when it wakes", async () => {
		const { t, member, companybot, record, turnId: ownTurn } = await setup();
		const general = (await generalOf(member))._id;
		// A webhook run's trigger: server-written, foreign provenance.
		const foreignTurn = await t.run(async (ctx) => {
			const chat = (await ctx.db.get(general))!;
			const triggerId = await ctx.db.insert("chatMessages", {
				chatId: general, workspaceId: chat.workspaceId, authorUserId: member.userId, text: "Lead came in", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done",
				automation: { id: "custom-hook", name: "Leads", foreign: true },
			});
			const session = await ctx.db.insert("agentSessions", { workspaceId: chat.workspaceId, agentId: companybot._id, chatId: general });
			return ctx.db.insert("agentTurns", { workspaceId: chat.workspaceId, chatId: general, agentId: companybot._id, triggerId, actorId: member.userId, status: "running", replyId: triggerId, sessionId: session });
		});
		const foreign = ((await create(t, foreignTurn, { note: "Follow up the lead", in: {days: 1}, recordId: record._id })) as { created: string }).created;
		const own = ((await create(t, ownTurn, { note: "Mine", in: {days: 1} })) as { created: string }).created;
		expect((await rowOf(t, foreign))!.foreign).toBe(true);
		expect((await rowOf(t, own))!.foreign).toBe(false);
		await t.run(async (ctx) => {
			for (const turn of await ctx.db.query("agentTurns").collect()) await ctx.db.patch(turn._id, { status: "done" });
		});

		const check = async (id: string) => {
			await fire(t, id);
			const [turn] = await turnsFor(t, id);
			const { decision } = await t.mutation(internal.permissions.check, { turnId: turn!._id, action: "records.save", risk: "inside" });
			await t.mutation(internal.turns.finishReply, { turnId: turn!._id });
			return decision;
		};
		// Only that call waits, as in an automation's run.
		expect(await check(foreign)).toMatchObject({ type: "ask", waitFor: expect.any(String) });
		expect(await check(own)).toMatchObject({ type: "run" });
	});
});

describe("jobs (#114)", () => {
	it("wakes on a job's result with no new trigger path", async () => {
		const { t, member, companybot, dmId } = await setup();
		await t.run(async (ctx) => {
			for (const turn of await ctx.db.query("agentTurns").collect()) await ctx.db.patch(turn._id, { status: "done" });
		});
		const id = await t.run(async (ctx) => {
			const chat = (await ctx.db.get(dmId))!;
			const id = await ctx.db.insert("wakeups", {
				workspaceId: chat.workspaceId, agentId: companybot._id, chatId: dmId, actorId: member.userId, createdBy: member.userId,
				note: "Tell them how the import went", foreign: false, status: "pending", jobId: "job-1",
			});
			await wake(ctx, id, { result: '{"rows":42}' });
			return id;
		});
		const [turn] = await turnsFor(t, id);
		expect((await t.mutation(internal.turns.turnContext, { turnId: turn!._id })).wake).toMatchObject({ result: '{"rows":42}' });
		expect((await rowOf(t, id))!.status).toBe("fired");
	});
});
