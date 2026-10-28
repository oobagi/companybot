import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { agentsOf, generalOf, identityOf, newTest, noMentions, ownerAndMember, signIn, turnsOf } from "./helpers";
import { person } from "./person";

afterEach(() => void vi.useRealTimers());

describe("onboarding", () => {
	// Hold the model reply back: the tests read the turn, not what the model says.
	beforeEach(() => void vi.useFakeTimers());

	it("has the main agent speak first in #general when someone makes a workspace, with fixed text and no model call", async () => {
		const t = newTest();
		const owner = await signIn(t, "founder@co.com", { welcome: true });
		const { companybot } = await agentsOf(owner);
		const general = await generalOf(owner);
		expect(general.members.some((m) => m.id === companybot._id)).toBe(true);
		expect(await turnsOf(t)).toEqual([]);

		const [hello, ...rest] = await owner.query(api.messages.list, { chatId: general._id });
		expect(rest).toEqual([]);
		expect(hello).toMatchObject({ author: { type: "agent", id: companybot._id }, status: "done", stats: null });
		expect(hello!.text).toContain("I'm Companybot");
		expect(hello!.text).toContain("@mention me with a few lines about the company");
		expect(hello!.text).toContain("team memory");
	});

	it("welcomes each person who joins in their DM with the main agent, by the name they set", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const { companybot } = await agentsOf(owner);
		await owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		const userId = await t.run((ctx) => ctx.db.insert("users", { email: "new@co.com" }));
		await t.run((ctx) => ctx.db.insert("preferences", { userId, displayName: "Ada", sendWith: "enter" }));
		await person(identityOf(t, userId)).mutation(api.workspace.ensure);
		const joiner = person(identityOf(t, userId), await t.run(async (ctx) => (await ctx.db.query("members").collect()).find((m) => m.userId === userId)!.workspaceId));
		const dm = (await joiner.query(api.chats.list))!.agents.find((a) => a._id === companybot._id)!.dmId;
		expect(dm).not.toBeNull();
		const [hello] = await joiner.query(api.messages.list, { chatId: dm! });
		expect(hello!.text).toMatch(/^Welcome, Ada! I'm Companybot\./);
		expect(hello!.text).toContain("I'll remember it");
		expect(await turnsOf(t)).toEqual([]);
	});

	it("ticks off tutorial steps as people do them, with Invite only for those who can invite", async () => {
		const { owner, member } = await ownerAndMember();
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
		const { t, member } = await ownerAndMember();
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
		const joiner = await signIn(t, "new@co.com", { welcome: true });
		expect(await joiner.query(api.chats.list)).toMatchObject({ dms: [] });
	});
});
