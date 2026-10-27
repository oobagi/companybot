import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

import { signIn, agentsOf, setup as ownerAndMember, generalOf, agentTurn, settle } from "./helpers";

// The tests drive turns themselves; keep scheduled model replies back.
beforeEach(() => void vi.useFakeTimers());

afterEach(() => void vi.useRealTimers());

describe("memory", () => {
	it("enforces team vs personal permissions", async () => {
		const { t, owner, member } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "We close at 5pm." });
		await expect(member.mutation(api.memory.create, { agentId, scope: "workspace", content: "x" })).rejects.toThrow(
			"permission",
		);
		await member.mutation(api.memory.create, { agentId, scope: "personal", content: "I like mornings." });

		const third = await (async () => {
			await owner.mutation(api.workspace.invite, { email: "third@co.com", role: "member" });
			return signIn(t, "third@co.com");
		})();

		const team = (await member.query(api.memory.list)).find((m) => m.scope === "workspace")!;
		expect(team.canEdit).toBe(false);
		expect((await third.query(api.memory.list)).map((m) => m.content)).toEqual(["We close at 5pm."]);
		// Owners see and change team memories, never anyone else's personal ones.
		expect(await owner.query(api.memory.list)).toMatchObject([{ content: "We close at 5pm.", canEdit: true }]);
		await owner.mutation(api.memory.update, { id: team.id as never, content: "We close at 6pm.", expectedVersion: 1 });
		expect((await member.query(api.memory.list)).map((m) => m.content)).toEqual(["We close at 6pm.", "I like mornings."]);
	});

	it("keeps personal memories from owners: no listing, editing or deleting", async () => {
		const { owner, member } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const theirs = await member.mutation(api.memory.create, { agentId, scope: "personal", content: "I'm job hunting." });
		expect(await owner.query(api.memory.list)).toEqual([]);
		await expect(owner.mutation(api.memory.update, { id: theirs.id as never, content: "x", expectedVersion: 1 })).rejects.toThrow(
			"Memory not found",
		);
		await expect(owner.mutation(api.memory.remove, { id: theirs.id as never })).rejects.toThrow("Memory not found");
		expect(await member.query(api.memory.list)).toMatchObject([{ content: "I'm job hunting.", canEdit: true }]);
	});

	it("deletes a member's personal memories when they're removed, keeping everyone else's", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		await member.mutation(api.memory.create, { agentId: companybot._id, scope: "personal", content: "Member note" });
		await member.mutation(api.memory.create, { agentId: scribe._id, scope: "personal", content: "Member note for Scribe" });
		await owner.mutation(api.memory.create, { agentId: companybot._id, scope: "personal", content: "Owner note" });
		await owner.mutation(api.memory.create, { agentId: companybot._id, scope: "workspace", content: "Team note" });
		const row = (await owner.query(api.workspace.team))!.members.find((m) => !m.isYou)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		await settle(t);
		const left = await t.run((ctx) => ctx.db.query("memories").collect());
		expect(left.map((m) => m.content)).toEqual(["Owner note", "Team note"]);
	});

	it("lets only owners turn memory off, kept across saves from older apps", async () => {
		const { owner, member } = await ownerAndMember();
		const settings = (await owner.query(api.workspace.settings))!;
		expect(settings.memory).toBe(true);
		await expect(
			member.mutation(api.workspace.updateSettings, { name: settings.name, memory: false, expectedVersion: settings.version }),
		).rejects.toThrow("permission");
		await owner.mutation(api.workspace.updateSettings, { name: settings.name, memory: false, expectedVersion: settings.version });
		expect((await member.query(api.workspace.settings))!.memory).toBe(false);
		// A save from an old version is refused, like any shared setting.
		await expect(
			owner.mutation(api.workspace.updateSettings, { name: settings.name, memory: true, expectedVersion: settings.version }),
		).rejects.toThrow();
		// Apps from before the switch send no `memory`; it stays as it was.
		await owner.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: settings.version + 1 });
		expect((await owner.query(api.workspace.settings))!.memory).toBe(false);
	});

	it("keeps each agent's memories separate", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		await owner.mutation(api.memory.create, { agentId: companybot._id, scope: "workspace", content: "Companybot fact" });
		await owner.mutation(api.memory.create, { agentId: scribe._id, scope: "workspace", content: "Scribe fact" });
		const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, scribe._id);
		const seen = await t.query(internal.memory.searchFor, { turnId, query: "" });
		expect(seen.map((m) => m.content)).toEqual(["Scribe fact"]);
	});

	it("lets agents fix and forget only what the person could", async () => {
		const { t, owner, member } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const team = await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "Office is in Austin." });
		const general = (await generalOf(member))._id;
		const id = team.id as never;
		const turnId = await agentTurn(t, member, general, agentId);
		await expect(t.mutation(internal.memory.removeFor, { turnId, id })).rejects.toThrow("can't change");
		const scribeTurn = await agentTurn(t, member, general, (await agentsOf(owner)).scribe._id);
		await expect(t.mutation(internal.memory.updateFor, { turnId: scribeTurn, id, content: "x" })).rejects.toThrow("can't change");
	});

	it("refuses an edit made against an old version", async () => {
		const { owner } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const memory = await owner.mutation(api.memory.create, { agentId, scope: "personal", content: "v1" });
		await owner.mutation(api.memory.update, { id: memory.id as never, content: "v2", expectedVersion: 1 });
		await expect(
			owner.mutation(api.memory.update, { id: memory.id as never, content: "stale", expectedVersion: 1 }),
		).rejects.toThrow();
		expect((await owner.query(api.memory.list))[0]!.content).toBe("v2");
	});

	it("cuts off an agent's access as soon as its person is removed", async () => {
		const { t, owner, member } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const turnId = await agentTurn(t, member, (await generalOf(member))._id, agentId);
		const team = (await owner.query(api.workspace.team))!;
		const row = team.members.find((m) => !m.isYou)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		await expect(t.query(internal.memory.searchFor, { turnId, query: "" })).rejects.toThrow("no longer");
	});
});

describe("memory in shared chats", () => {
	it("refuses personal memories when 2+ people can read the chat", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const agentId = companybot._id;
		const mine = await owner.mutation(api.memory.create, { agentId, scope: "personal", content: "I'm vegan." });
		await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "We close at 5." });
		const shared = { turnId: await agentTurn(t, owner, (await generalOf(owner))._id, agentId) };
		expect((await t.query(internal.memory.searchFor, { ...shared, query: "" })).map((m) => m.content)).toEqual(["We close at 5."]);
		await expect(t.mutation(internal.memory.createFor, { ...shared, scope: "personal", content: "x" })).rejects.toThrow(
			"Personal memories are off",
		);
		await expect(t.mutation(internal.memory.removeFor, { ...shared, id: mine.id as Id<"memories"> })).rejects.toThrow(
			"Personal memories are off",
		);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
		expect(await t.query(internal.memory.searchFor, { turnId: await agentTurn(t, owner, dm, agentId), query: "" })).toHaveLength(2);
	});
});
