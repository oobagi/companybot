import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import migrationsTest from "@convex-dev/migrations/test";
import { addToChat, dropSeat } from "../convex/chatOps";
import { savePreferences } from "../convex/preferences";
import { addMember, agentTurn, agentsOf, generalOf, identityOf, newTest, ownerAndMember, settle, signIn, workspaceOf } from "./helpers";
import { person } from "./person";

// Lists of members stay a few reads however big the team is (members carry their profile, chats their count).
// Each of these ran out of reads (4,096 per call) at this size before.

afterEach(() => void vi.useRealTimers());

/** `n` people in the workspace, 500 a transaction, seated in `chatId` (as joining it does) if given. Returns their user ids. */
async function seedPeople(t: ReturnType<typeof newTest>, workspaceId: Id<"workspaces">, n: number, chatId?: Id<"chats">) {
	const ids: Id<"users">[] = [];
	for (let start = 0; start < n; start += 500) {
		ids.push(
			...(await t.run(async (ctx) => {
				const batch: Id<"users">[] = [];
				for (let i = start; i < Math.min(start + 500, n); i++) {
					const userId = await ctx.db.insert("users", { email: `person${i}@co.com` });
					await addMember(ctx, { workspaceId, userId, role: "member", email: `person${i}@co.com` });
					if (chatId) await addToChat(ctx, (await ctx.db.get(chatId))!, { userId });
					batch.push(userId);
				}
				return batch;
			})),
		);
	}
	return ids;
}

it("lists a team of 1,500 with their names, photos and zones", { timeout: 300_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const [ada] = await seedPeople(t, workspaceId, 1_500);
	await t.run((ctx) => savePreferences(ctx, ada!, { displayName: "Ada Lovelace", timeZone: "Asia/Tokyo" }));
	const team = (await owner.query(api.workspace.team))!;
	expect(team.members).toHaveLength(1_501);
	expect(team.members.find((m) => m.userId === ada)).toMatchObject({ name: "Ada Lovelace", email: "person0@co.com", timeZone: "Asia/Tokyo" });
});

it("runs a turn in a channel of 2,500, naming who's talking and counting the rest", { timeout: 300_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const general = (await generalOf(owner))._id;
	const [ada] = await seedPeople(t, workspaceId, 2_500, general);
	await t.run((ctx) => savePreferences(ctx, ada!, { displayName: "Ada" }));
	await person(identityOf(t, ada!), workspaceId).mutation(api.messages.send, { chatId: general, text: "Numbers are in", mentions: { userIds: [], agentIds: [] } });
	const { companybot } = await agentsOf(owner);
	const turnId = await agentTurn(t, owner, general, companybot._id);
	const { place } = await t.mutation(internal.turns.turnContext, { turnId });
	const people = place.members.filter((m) => m.type === "user").map((m) => m.name);
	expect(people.sort()).toEqual(["Ada", "owner@co.com"]);
	expect(place.members.some((m) => m.type === "agent" && m.id === companybot._id)).toBe(true);
	expect(place.others).toBe(2_500 - 1);
});

it("finds a teammate by email or name among 1,500", { timeout: 300_000 }, async () => {
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const people = await seedPeople(t, workspaceId, 1_500);
	await t.run((ctx) => savePreferences(ctx, people[700]!, { displayName: "Grace Hopper" }));
	const general = (await generalOf(owner))._id;
	const turnId = await agentTurn(t, owner, general, (await agentsOf(owner)).companybot._id);
	const save = (owner: string) => t.mutation(internal.recordTools.saveFor, { turnId, input: { type: "deal", values: { name: `For ${owner}`, owner } } });
	expect(await save("Person1200@co.com")).toMatchObject({ values: { owner: "person1200@co.com" } });
	expect(await save("grace hopper")).toMatchObject({ values: { owner: "Grace Hopper" } });
	expect(await save("Nobody")).toEqual({ error: expect.stringContaining("and 1482 more") });
});

it("browses 50 channels of 1,000 people each, with their counts", { timeout: 600_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const newcomer = await signIn(t, "new@co.com");
	await t.run((ctx) => addMember(ctx, { workspaceId, userId: newcomer.userId, role: "member", email: "new@co.com" }));
	const people = await seedPeople(t, workspaceId, 1_000);
	for (let c = 0; c < 50; c++) {
		const chatId = await owner.mutation(api.chats.createChannel, { name: `team-${c}`, private: false });
		// The owner made it, so 999 more, in bulk with the count they'd leave (counting itself: lifecycle and migration tests).
		await t.run(async (ctx) => {
			for (const userId of people.slice(1)) await ctx.db.insert("chatMembers", { chatId, workspaceId, userId, lastReadAt: 0 });
			await ctx.db.patch(chatId, { memberCount: 1_000 });
		});
	}
	// #general shows too: they joined without a seat in it.
	const channels = (await newcomer.in(workspaceId).query(api.chats.browse)).filter((c) => c.name.startsWith("team-"));
	expect(channels).toHaveLength(50);
	expect(channels.every((c) => c.memberCount === 1_000)).toBe(true);
});

// COMPAT(0.1.0-alpha.10): delete with migrations.chatMemberCounts.
it("counts 5 channels of 7,000 seats from before counts, over several transactions, with seats changing meanwhile", { timeout: 600_000 }, async () => {
	const t = newTest();
	migrationsTest.register(t);
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const people = await seedPeople(t, workspaceId, 7_000);
	const channels: Id<"chats">[] = [];
	for (let c = 0; c < 5; c++) {
		const chatId = await owner.mutation(api.chats.createChannel, { name: `big-${c}`, private: false });
		channels.push(chatId);
		for (let start = 0; start < people.length; start += 3_500)
			await t.run(async (ctx) => {
				for (const userId of people.slice(start, start + 3_500)) await ctx.db.insert("chatMembers", { chatId, workspaceId, userId, lastReadAt: 0 });
			});
		// As before counts: the owner's seat and 7,000 more, uncounted.
		await t.run((ctx) => ctx.db.patch(chatId, { memberCount: undefined }));
	}
	vi.useFakeTimers();
	// Partway through the first: one seat it counted leaves, and someone new joins.
	await t.mutation(internal.migrations.continueSeatCount, { chatId: channels[0]! });
	expect((await t.run((ctx) => ctx.db.get(channels[0]!)))!.seatCount).toMatchObject({ counted: 4_000 });
	await t.run(async (ctx) => {
		const oldest = (await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", channels[0]!)).first())!;
		await dropSeat(ctx, oldest);
		const newcomer = await ctx.db.insert("users", { email: "late@co.com" });
		await addToChat(ctx, (await ctx.db.get(channels[0]!))!, { userId: newcomer });
	});
	await t.mutation(internal.migrations.runAll);
	await settle(t);
	const counts = await t.run(async (ctx) => Promise.all(channels.map(async (id) => (await ctx.db.get(id))!)));
	expect(counts.map((c) => c.memberCount)).toEqual([7_001, 7_001, 7_001, 7_001, 7_001]);
	expect(counts.every((c) => c.seatCount === undefined)).toBe(true);
});
