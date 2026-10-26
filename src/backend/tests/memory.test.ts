import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MEMORY_RESULTS_MAX } from "../convex/memoryOps";
import schema from "../convex/schema";
import { person } from "./person";

// Agent memory (memory.ts), as an agent turn calls it: acting for the turn's person, checked
// fresh on every call (runningTurn), with personal memories only in a DM with exactly one person.

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/_generated/*.js"]);

async function signIn(t: ReturnType<typeof convexTest>, email: string) {
	const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
	const as = person(t.withIdentity({ subject: `${userId}|session` }));
	await as.mutation(api.workspace.ensure);
	return Object.assign(as, { userId });
}

type As = Awaited<ReturnType<typeof signIn>>;

async function setup() {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const owner = await signIn(t, "owner@co.com");
	await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
	const member = await signIn(t, "member@co.com");
	const companybot = (await owner.query(api.agents.list)).find((a) => a.name === "Companybot")!._id;
	const general = (await owner.query(api.chats.list))!.channels.find((c) => c.isDefault)!._id;
	return { t, owner, member, companybot, general };
}

/** A running Companybot turn for `as` in `chatId`, and the memory calls it makes. */
async function turnIn(t: ReturnType<typeof convexTest>, as: As, chatId: Id<"chats">, agentId: Id<"agents">) {
	const before = await t.run((ctx) => ctx.db.query("agentTurns").collect());
	await as.mutation(api.messages.send, { chatId, text: "hi", mentions: { userIds: [], agentIds: [agentId] } });
	const turns = await t.run((ctx) => ctx.db.query("agentTurns").collect());
	const turnId = turns.find((x) => !before.some((b) => b._id === x._id))!._id;
	return {
		turnId,
		search: (query = "") => t.query(internal.memory.searchFor, { turnId, query }),
		create: (scope: "workspace" | "personal", content: string) => t.mutation(internal.memory.createFor, { turnId, scope, content }),
		update: (id: string, content: string) => t.mutation(internal.memory.updateFor, { turnId, id: id as Id<"memories">, content }),
		remove: (id: string) => t.mutation(internal.memory.removeFor, { turnId, id: id as Id<"memories"> }),
	};
}

/** Adds memories straight to the table, oldest first: history too big to make one call at a time. */
async function insertMemories(t: ReturnType<typeof convexTest>, agentId: Id<"agents">, rows: { scope: "workspace" | "personal"; ownerId: Id<"users"> | null; content: string }[]) {
	await t.run(async (ctx) => {
		const agent = (await ctx.db.get(agentId))!;
		for (const row of rows)
			await ctx.db.insert("memories", { workspaceId: agent.workspaceId, agentId, ...row, updatedAt: Date.now(), updatedBy: agent.updatedBy, version: 1 });
	});
}

const dmWith = (as: As, agentId: Id<"agents">) => as.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });

/** Every memory call, expected to fail with `message`. */
async function allRefused(turn: Awaited<ReturnType<typeof turnIn>>, id: string, message: string) {
	await expect(turn.search()).rejects.toThrow(message);
	await expect(turn.create("personal", "x")).rejects.toThrow(message);
	await expect(turn.update(id, "x")).rejects.toThrow(message);
	await expect(turn.remove(id)).rejects.toThrow(message);
}

describe("agent memory", () => {
	// Holds back the scheduled reply (it would call a model), so the turn stays running.
	beforeEach(() => void vi.useFakeTimers());
	afterEach(() => void vi.useRealTimers());

	it("keeps personal memories to a DM with exactly one person", async () => {
		const { t, owner, member, companybot, general } = await setup();
		await owner.mutation(api.memory.create, { agentId: companybot, scope: "workspace", content: "We close at 5." });
		const dm = await turnIn(t, owner, await dmWith(owner, companybot), companybot);
		const mine = await dm.create("personal", "I'm vegan.");
		expect((await dm.search()).map((m) => m.content)).toEqual(["We close at 5.", "I'm vegan."]);
		await dm.update(mine.id, "I'm vegetarian.");

		const shared = [
			await turnIn(t, owner, general, companybot),
			await turnIn(t, owner, await owner.mutation(api.chats.openDm, { userIds: [member.userId], agentIds: [companybot] }), companybot),
		];
		for (const turn of shared) {
			expect((await turn.search()).map((m) => m.content)).toEqual(["We close at 5."]);
			await expect(turn.create("personal", "x")).rejects.toThrow("Personal memories are off");
			await expect(turn.update(mine.id, "x")).rejects.toThrow("Personal memories are off");
			await expect(turn.remove(mine.id)).rejects.toThrow("Personal memories are off");
		}
		expect((await owner.query(api.memory.list)).find((m) => m.id === mine.id)?.content).toBe("I'm vegetarian.");
	});

	it("blocks reads and writes once the person is removed", async () => {
		const { t, owner, member, companybot } = await setup();
		const turn = await turnIn(t, member, await dmWith(member, companybot), companybot);
		const mine = await turn.create("personal", "Likes tea.");
		const row = (await owner.query(api.workspace.team))!.members.find((m) => !m.isYou)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		await allRefused(turn, mine.id, "no longer in the workspace");
	});

	it.each(["remove", "leave"])("cleans only that workspace on %s, including archived agents, and spares memories after rejoining", async (how) => {
		const { t, owner, member, companybot } = await setup();
		const other = await signIn(t, "other@co.com");
		const otherWorkspace = (await other.query(api.workspace.me))!.workspaceId!;
		await other.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
		await member.mutation(api.workspace.acceptInvite, { id: (await member.query(api.workspace.mine))!.invitations[0]!.id });
		const otherAgent = (await other.query(api.agents.list))[0]!._id;
		const elsewhere = member.in(otherWorkspace);
		await elsewhere.mutation(api.memory.create, { agentId: otherAgent, scope: "personal", content: "Other workspace" });
		await owner.mutation(api.memory.create, { agentId: companybot, scope: "personal", content: "Owner note" });
		await owner.mutation(api.memory.create, { agentId: companybot, scope: "workspace", content: "Team note" });
		const scribe = (await owner.query(api.agents.list)).find((a) => a.name === "Scribe")!._id;
		await member.mutation(api.memory.create, { agentId: scribe, scope: "personal", content: "Archived agent note" });
		await owner.mutation(api.agents.setArchived, { agentId: scribe, archived: true });
		await member.mutation(api.memory.create, { agentId: companybot, scope: "personal", content: "Current note" });
		await insertMemories(t, companybot, Array.from({ length: 205 }, (_, i) => ({ scope: "personal", ownerId: member.userId, content: `Old note ${i}` })));

		await member.mutation(api.workspace.switchTo, { to: otherWorkspace });
		if (how === "leave") await member.mutation(api.workspace.leave);
		else {
			const row = (await owner.query(api.workspace.team))!.members.find((m) => !m.isYou)!;
			await owner.mutation(api.workspace.removeMember, { id: row.id });
		}
		expect(await member.query(api.memory.list)).toEqual([]);
		const workspaceId = (await owner.query(api.workspace.me))!.workspaceId!;
		const before = await t.run(async (ctx) => ctx.meta.getSnapshotTs());
		await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
		await member.mutation(api.workspace.acceptInvite, { id: (await member.query(api.workspace.mine))!.invitations[0]!.id });
		const fresh = await member.mutation(api.memory.create, { agentId: companybot, scope: "personal", content: "After rejoining" });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await member.query(api.memory.list)).map((m) => m.content)).toEqual(["Team note", "After rejoining"]);
		expect((await elsewhere.query(api.memory.list)).map((m) => m.content)).toEqual(["Other workspace"]);
		expect((await owner.query(api.memory.list)).map((m) => m.content)).toEqual(["Owner note", "Team note"]);
		// Retrying an old cleanup must also spare the new membership's memory.
		await t.mutation(internal.memory.forgetForRemovedMember, { workspaceId, userId: member.userId, before });
		await member.mutation(api.memory.update, { id: fresh.id as Id<"memories">, content: "New note", expectedVersion: 1 });
		expect((await member.query(api.memory.list)).at(-1)?.content).toBe("New note");
	});

	it("applies a demotion to the very next call", async () => {
		const { t, owner, member, companybot } = await setup();
		const row = (await owner.query(api.workspace.team))!.members.find((m) => !m.isYou)!;
		await owner.mutation(api.workspace.setRole, { id: row.id, role: "owner" });
		await member.mutation(api.memory.create, { agentId: companybot, scope: "personal", content: "Member's note." });
		await owner.mutation(api.memory.create, { agentId: companybot, scope: "personal", content: "Owner's note." });
		const turn = await turnIn(t, member, await dmWith(member, companybot), companybot);
		const team = await turn.create("workspace", "Office is in Austin.");
		// Being an owner never shows anyone else's personal memories.
		expect((await turn.search("note")).map((m) => m.content)).toEqual(["Member's note."]);

		await owner.mutation(api.workspace.setRole, { id: row.id, role: "member" });
		expect((await turn.search("note")).map((m) => m.content)).toEqual(["Member's note."]);
		await expect(turn.create("workspace", "x")).rejects.toThrow("permission");
		await expect(turn.update(team.id, "x")).rejects.toThrow("can't change");
		await expect(turn.remove(team.id)).rejects.toThrow("can't change");
	});

	it("blocks reads and writes once the turn has stopped", async () => {
		const { t, owner, companybot } = await setup();
		const turn = await turnIn(t, owner, await dmWith(owner, companybot), companybot);
		const mine = await turn.create("personal", "Likes tea.");
		await t.mutation(internal.turns.finishReply, { turnId: turn.turnId, error: "Stopped." });
		await allRefused(turn, mine.id, "stopped");
	});

	it("blocks reads and writes once the person can't see the chat", async () => {
		const { t, owner, member, companybot } = await setup();
		const chatId = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		await owner.mutation(api.chats.addMembers, { chatId, userIds: [member.userId], agentIds: [] });
		const team = await owner.mutation(api.memory.create, { agentId: companybot, scope: "workspace", content: "Board meets Fridays." });
		const turn = await turnIn(t, member, chatId, companybot);
		expect((await turn.search()).map((m) => m.content)).toEqual(["Board meets Fridays."]);
		await member.mutation(api.chats.leave, { chatId });
		await allRefused(turn, team.id, "can no longer see");
	});

	it("finds a match anywhere in the history, by word or prefix, not substring", async () => {
		const { t, owner, companybot } = await setup();
		await insertMemories(t, companybot, [
			{ scope: "workspace", ownerId: null, content: "Roof warranty lasts ten years." },
			...Array.from({ length: 600 }, (_, i) => ({ scope: "workspace" as const, ownerId: null, content: `Unrelated note ${i}` })),
		]);
		const turn = await turnIn(t, owner, await dmWith(owner, companybot), companybot);
		expect((await turn.search("warranty")).map((m) => m.content)).toEqual(["Roof warranty lasts ten years."]);
		expect((await turn.search("roof warr")).map((m) => m.content)).toEqual(["Roof warranty lasts ten years."]);
		expect(await turn.search("arranty")).toEqual([]);
		expect(await turn.search("warranty unrelated")).toEqual([]);
	});

	it("searches and lists only the person's own personal memories, owners included, however many others wrote", async () => {
		const { t, owner, member, companybot } = await setup();
		const old = (who: Id<"users">, n: number) =>
			Array.from({ length: n }, (_, i) => ({ scope: "personal" as const, ownerId: who, content: `Old ${who === owner.userId ? "owner" : "member"} note ${i}` }));
		// Each person in turn writes a lot, then the other writes one new match: whichever id sorts first, the new one must win.
		await insertMemories(t, companybot, old(member.userId, 600));
		await insertMemories(t, companybot, [{ scope: "personal", ownerId: owner.userId, content: "Owner's fresh lead: Dana." }]);
		await insertMemories(t, companybot, old(owner.userId, 600));
		await insertMemories(t, companybot, [{ scope: "personal", ownerId: member.userId, content: "Member's fresh lead: Ben." }]);
		const owners = await turnIn(t, owner, await dmWith(owner, companybot), companybot);
		expect((await owners.search("fresh lead")).map((m) => m.content)).toEqual(["Owner's fresh lead: Dana."]);
		const newest = (await owners.search()).map((m) => m.content);
		expect(newest).toHaveLength(MEMORY_RESULTS_MAX);
		expect(newest.every((c) => c.startsWith("Old owner note"))).toBe(true);

		const members = await turnIn(t, member, await dmWith(member, companybot), companybot);
		expect((await members.search("fresh lead")).map((m) => m.content)).toEqual(["Member's fresh lead: Ben."]);
		expect((await members.search()).at(-1)?.content).toBe("Member's fresh lead: Ben.");
	});

	it("never shows or changes another person's personal memories for an owner", async () => {
		const { t, owner, member, companybot } = await setup();
		const theirs = await member.mutation(api.memory.create, { agentId: companybot, scope: "personal", content: "Member's salary is 90k." });
		await member.mutation(api.memory.create, { agentId: companybot, scope: "personal", content: "Prefers email." });
		const turn = await turnIn(t, owner, await dmWith(owner, companybot), companybot);
		expect(await turn.search()).toEqual([]);
		expect(await turn.search("salary")).toEqual([]);
		await expect(turn.update(theirs.id, "x")).rejects.toThrow("Memory not found");
		await expect(turn.remove(theirs.id)).rejects.toThrow("Memory not found");
		expect((await member.query(api.memory.list)).map((m) => m.content)).toEqual(["Member's salary is 90k.", "Prefers email."]);
	});

	it("reads and writes nothing while an owner has memory turned off, and keeps every memory", async () => {
		const { t, owner, member, companybot } = await setup();
		const mine = await member.mutation(api.memory.create, { agentId: companybot, scope: "personal", content: "Likes tea." });
		await owner.mutation(api.memory.create, { agentId: companybot, scope: "workspace", content: "We close at 5." });
		const turn = await turnIn(t, member, await dmWith(member, companybot), companybot);
		const setMemory = async (memory: boolean) => {
			const { name, version } = (await owner.query(api.workspace.settings))!;
			await owner.mutation(api.workspace.updateSettings, { name, memory, expectedVersion: version });
		};

		await setMemory(false);
		await allRefused(turn, mine.id, "turned memory off");
		await expect(turn.create("workspace", "x")).rejects.toThrow("turned memory off");
		expect((await t.query(internal.turns.turnContext, { turnId: turn.turnId })).memory).toBe("off");
		expect(await member.query(api.memory.list)).toHaveLength(2);
		await member.mutation(api.memory.update, { id: mine.id as Id<"memories">, content: "Likes coffee.", expectedVersion: 1 });
		const temporary = await member.mutation(api.memory.create, { agentId: companybot, scope: "personal", content: "Temporary" });
		await member.mutation(api.memory.remove, { id: temporary.id as Id<"memories"> });

		await setMemory(true);
		expect((await turn.search()).map((m) => m.content)).toEqual(["Likes coffee.", "We close at 5."]);
		expect((await t.query(internal.turns.turnContext, { turnId: turn.turnId })).memory).toBe("personal");
	});

	it("keeps the switch scoped to the turn's workspace after the person switches away", async () => {
		const { t, owner, companybot, general } = await setup();
		const other = await signIn(t, "other@co.com");
		const otherWorkspace = (await other.query(api.workspace.me))!.workspaceId!;
		await other.mutation(api.workspace.invite, { email: "owner@co.com", role: "owner" });
		await owner.mutation(api.workspace.acceptInvite, { id: (await owner.query(api.workspace.mine))!.invitations[0]!.id });
		const otherAgent = (await other.query(api.agents.list))[0]!._id;
		const otherTurn = await turnIn(t, other, await dmWith(other, otherAgent), otherAgent);
		const otherMemory = await otherTurn.create("personal", "Other workspace");
		const turn = await turnIn(t, owner, general, companybot);
		const team = await turn.create("workspace", "Team note");
		const { name, version } = (await owner.query(api.workspace.settings))!;
		await owner.mutation(api.workspace.updateSettings, { name, memory: false, expectedVersion: version });
		await owner.mutation(api.workspace.switchTo, { to: otherWorkspace });
		await allRefused(turn, team.id, "turned memory off");
		await expect(turn.create("workspace", "x")).rejects.toThrow("turned memory off");
		expect((await t.query(internal.turns.turnContext, { turnId: turn.turnId })).memory).toBe("off");
		expect((await otherTurn.search()).map((m) => m.id)).toEqual([otherMemory.id]);
		expect((await t.query(internal.turns.turnContext, { turnId: otherTurn.turnId })).memory).toBe("personal");
	});

	it("searches by every word and returns the newest when there are many", async () => {
		const { t, owner, companybot } = await setup();
		const turn = await turnIn(t, owner, await dmWith(owner, companybot), companybot);
		await turn.create("workspace", "Office is in Austin.");
		await turn.create("personal", "Prefers calls in the AFTERNOON.");
		expect((await turn.search("afternoon calls")).map((m) => m.content)).toEqual(["Prefers calls in the AFTERNOON."]);
		expect(await turn.search("austin calls")).toEqual([]);
		for (let i = 0; i < MEMORY_RESULTS_MAX; i++) await turn.create("workspace", `Fact ${i}`);
		const all = await turn.search();
		expect(all).toHaveLength(MEMORY_RESULTS_MAX);
		expect(all.at(-1)?.content).toBe(`Fact ${MEMORY_RESULTS_MAX - 1}`);
		expect(all.map((m) => m.content)).not.toContain("Office is in Austin.");
	});
});
