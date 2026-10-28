import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { agentsOf, generalOf, newTest, noMentions, setup, signIn, turnsOf } from "./helpers";
import { person } from "./person";

afterEach(() => void vi.useRealTimers());

/** Signs in without skipping the welcome, the way the app does. */
async function arrive(t: ReturnType<typeof newTest>, email: string) {
	const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
	const identity = t.withIdentity({ subject: `${userId}|session` });
	await person(identity).mutation(api.workspace.ensure);
	const first = await t.run(async (ctx) => (await ctx.db.query("members").collect()).find((m) => m.userId === userId));
	return Object.assign(person(identity, first?.workspaceId), { userId });
}

describe("onboarding", () => {
	// Hold the model reply back: the tests read the turn, not what the model says.
	beforeEach(() => void vi.useFakeTimers());

	it("has the main agent speak first in #general when someone makes a workspace", async () => {
		const t = newTest();
		const owner = await arrive(t, "founder@co.com");
		const { companybot } = await agentsOf(owner);
		const general = await generalOf(owner);
		expect(general.members.some((m) => m.id === companybot._id)).toBe(true);

		const [turn, ...rest] = await turnsOf(t);
		expect(rest).toEqual([]);
		expect(turn).toMatchObject({ chatId: general._id, agentId: companybot._id, actorId: owner.userId, welcome: "new_workspace", status: "running" });
		expect(turn!.triggerId).toBeUndefined();

		const context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		expect(context).toMatchObject({ triggerId: null, welcome: "new_workspace", messages: [], approval: null });
		// Nothing to react to yet.
		expect(await t.mutation(internal.chatTools.reactFor, { turnId: turn!._id, emoji: "👋" })).toMatchObject({ error: expect.stringContaining("Nobody asked") });
	});

	it("welcomes each person who joins, acting as them", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		await owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		const joiner = await arrive(t, "new@co.com");
		const turns = await turnsOf(t);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ actorId: joiner.userId, welcome: "joined", chatId: (await generalOf(owner))._id });
	});

	it("ticks off tutorial steps as people do them, with Invite only for those who can invite", async () => {
		const { owner, member } = await setup();
		const { companybot } = await agentsOf(owner);
		const general = await generalOf(owner);
		const steps = async (as: typeof owner) => (await as.query(api.onboarding.tutorial))?.map((s) => `${s.id}${s.done ? " ✓" : ""}`) ?? null;
		expect(await steps(owner)).toEqual(["mention", "dm", "thread", "invite ✓"]);
		expect(await steps(member)).toEqual(["mention", "dm", "thread"]);

		// A message with no mention teaches nothing, nor does mentioning an agent that won't answer
		// (a DM between people); mentioning one that answers does.
		const parent = await member.mutation(api.messages.send, { chatId: general._id, text: "hello", mentions: noMentions });
		const people = await member.mutation(api.chats.openDm, { userIds: [owner.userId], agentIds: [] });
		await member.mutation(api.messages.send, { chatId: people, text: "@Companybot?", mentions: { userIds: [], agentIds: [companybot._id] } });
		expect(await steps(member)).toEqual(["mention", "dm", "thread"]);
		await member.mutation(api.messages.send, { chatId: general._id, text: "@Companybot hi", mentions: { userIds: [], agentIds: [companybot._id] } });
		await member.mutation(api.messages.send, { chatId: general._id, threadId: parent, text: "more", mentions: noMentions });
		expect(await steps(member)).toEqual(["mention ✓", "dm", "thread ✓"]);

		const dm = await member.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await member.mutation(api.messages.send, { chatId: dm, text: "private", mentions: noMentions });
		// All done: the tray goes away.
		expect(await steps(member)).toBeNull();

		await owner.mutation(api.onboarding.dismissTutorial);
		expect(await steps(owner)).toBeNull();
	});

	it("gives no tutorial to people who joined before it", async () => {
		const { t, member } = await setup();
		await t.run(async (ctx) => {
			for (const m of await ctx.db.query("members").collect()) await ctx.db.patch(m._id, { tutorial: undefined });
		});
		expect(await member.query(api.onboarding.tutorial)).toBeNull();
		await member.mutation(api.onboarding.dismissTutorial);
		expect(await member.query(api.onboarding.tutorial)).toBeNull();
	});

	it("skips the welcome when the workspace has no active agent", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const { companybot } = await agentsOf(owner);
		await t.run((ctx) => ctx.db.patch(companybot._id, { archived: true }));
		await owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		await arrive(t, "new@co.com");
		expect(await turnsOf(t)).toEqual([]);
	});
});
