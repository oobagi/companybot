import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/_generated/*.js"]);

/** A signed-in person. Convex Auth reads the user id from the token subject. */
async function signIn(t: ReturnType<typeof convexTest>, email: string) {
	const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
	const as = t.withIdentity({ subject: `${userId}|session` });
	await as.mutation(api.workspace.ensure);
	return as;
}

/** The workspace's agents by name. */
async function agentsOf(as: Awaited<ReturnType<typeof signIn>>) {
	const list = await as.query(api.agents.list);
	const byName = (name: string) => list.find((a) => a.name === name)!;
	return { list, companybot: byName("Companybot"), scribe: byName("Scribe") };
}

async function ownerAndMember() {
	const t = convexTest(schema, modules);
	const owner = await signIn(t, "owner@co.com");
	await owner.mutation(api.workspace.invite, { email: "Member@Co.com", role: "member" });
	const member = await signIn(t, "member@co.com");
	return { t, owner, member };
}

describe("workspaces", () => {
	it("makes the first person owner and lets invited people join as members", async () => {
		const { owner, member } = await ownerAndMember();
		expect((await owner.query(api.workspace.me))?.role).toBe("owner");
		expect((await member.query(api.workspace.me))?.role).toBe("member");
		expect((await owner.query(api.workspace.team))?.members).toHaveLength(2);
	});

	it("only lets owners invite", async () => {
		const { member } = await ownerAndMember();
		await expect(member.mutation(api.workspace.invite, { email: "x@co.com", role: "member" })).rejects.toThrow(
			"Only owners",
		);
	});
});

describe("memory", () => {
	it("enforces team vs personal permissions", async () => {
		const { t, owner, member } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "We close at 5pm." });
		await expect(member.mutation(api.memory.create, { agentId, scope: "workspace", content: "x" })).rejects.toThrow(
			"Only owners",
		);
		await member.mutation(api.memory.create, { agentId, scope: "personal", content: "I like mornings." });

		const third = await (async () => {
			await owner.mutation(api.workspace.invite, { email: "third@co.com", role: "member" });
			return signIn(t, "third@co.com");
		})();

		const team = (await member.query(api.memory.list)).find((m) => m.scope === "workspace")!;
		expect(team.canEdit).toBe(false);
		expect((await third.query(api.memory.list)).map((m) => m.content)).toEqual(["We close at 5pm."]);
		expect(await owner.query(api.memory.list)).toHaveLength(2);
	});

	it("keeps each agent's memories separate", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		await owner.mutation(api.memory.create, { agentId: companybot._id, scope: "workspace", content: "Companybot fact" });
		await owner.mutation(api.memory.create, { agentId: scribe._id, scope: "workspace", content: "Scribe fact" });
		const userId = companybot.updatedBy;
		const seen = await t.query(internal.memory.listFor, { userId, agentId: scribe._id });
		expect(seen.map((m) => m.content)).toEqual(["Scribe fact"]);
	});

	it("refuses an edit made against an old version", async () => {
		const { owner } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const memory = await owner.mutation(api.memory.create, { agentId, scope: "personal", content: "v1" });
		await owner.mutation(api.memory.update, { id: memory.id as never, content: "v2", expectedVersion: 1 });
		await expect(
			owner.mutation(api.memory.update, { id: memory.id as never, content: "stale", expectedVersion: 1 }),
		).rejects.toThrow();
		expect((await owner.query(api.memory.list))[0].content).toBe("v2");
	});

	it("cuts off an agent's access as soon as its person is removed", async () => {
		const { t, owner } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const team = (await owner.query(api.workspace.team))!;
		const row = team.members.find((m) => !m.isYou)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		await expect(t.query(internal.memory.listFor, { userId: row.userId, agentId })).rejects.toThrow("no longer");
	});
});

describe("agents", () => {
	it("gives new workspaces the default agents", async () => {
		const { owner } = await ownerAndMember();
		expect((await agentsOf(owner)).list.map((a) => a.name)).toEqual(["Companybot", "Scribe"]);
	});

	it("versions every save and restores old versions", async () => {
		const { owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const config = { name: scribe.name, description: scribe.description, instructions: "Be terse.", model: scribe.model, tools: scribe.tools };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config });
		await owner.mutation(api.agents.restore, { agentId: scribe._id, version: 1, expectedVersion: 2 });
		const history = await owner.query(api.agents.history, { agentId: scribe._id });
		expect(history.map((h) => [h.version, h.config.instructions.slice(0, 10)])).toEqual([
			[3, "You are Sc"],
			[2, "Be terse."],
			[1, "You are Sc"],
		]);
	});

	it("refuses a save when someone else saved first", async () => {
		const { owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const config = { name: "A", description: "", instructions: "", model: scribe.model, tools: [] };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config });
		await expect(
			owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config: { ...config, name: "B" } }),
		).rejects.toThrow();
	});

	it("lets only owners edit, and rejects unknown tools", async () => {
		const { owner, member } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const config = { name: "X", description: "", instructions: "", model: scribe.model, tools: [] as string[] };
		await expect(member.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config })).rejects.toThrow(
			"Only owners",
		);
		await expect(
			owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config: { ...config, tools: ["x.y"] } }),
		).rejects.toThrow("Unknown tool");
	});

	it("archives agents but keeps at least one", async () => {
		const { owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		await owner.mutation(api.agents.setArchived, { agentId: scribe._id, archived: true });
		await expect(owner.mutation(api.chat.send, { agentId: scribe._id, text: "hi" })).rejects.toThrow(
			"archived",
		);
		await expect(owner.mutation(api.agents.setArchived, { agentId: companybot._id, archived: true })).rejects.toThrow(
			"at least one",
		);
	});
});

describe("settings", () => {
	it("keeps at least one owner and applies role changes at once", async () => {
		const { owner, member } = await ownerAndMember();
		const team = (await owner.query(api.workspace.team))!;
		const me = team.members.find((m) => m.isYou)!;
		const them = team.members.find((m) => !m.isYou)!;
		await expect(owner.mutation(api.workspace.setRole, { id: me.id, role: "member" })).rejects.toThrow("at least one owner");
		await owner.mutation(api.workspace.setRole, { id: them.id, role: "owner" });
		expect((await member.query(api.workspace.me))?.role).toBe("owner");
	});

	it("refuses a stale workspace rename", async () => {
		const { owner } = await ownerAndMember();
		await owner.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: 1 });
		await expect(owner.mutation(api.workspace.updateSettings, { name: "Other", expectedVersion: 1 })).rejects.toThrow();
		expect((await owner.query(api.workspace.settings))?.name).toBe("Acme");
	});

	it("keeps preferences personal", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.preferences.update, { displayName: "Jaden", sendWith: "mod-enter" });
		expect(await owner.query(api.preferences.get)).toEqual({ displayName: "Jaden", sendWith: "mod-enter" });
		expect((await member.query(api.preferences.get)).displayName).toBe("");
		expect((await member.query(api.workspace.team))?.members.map((m) => m.name)).toContain("Jaden");
	});
});

describe("customize", () => {
	it("lets only owners install skills", async () => {
		const { owner, member } = await ownerAndMember();
		await expect(member.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true })).rejects.toThrow(
			"Only owners",
		);
		await owner.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true });
		expect((await member.query(api.skills.list)).find((s) => s.id === "meeting-notes")?.installed).toBe(true);
	});

	it("hides owner-only tools from members", async () => {
		const { owner, member } = await ownerAndMember();
		const tool = async (as: typeof owner) =>
			(await agentsOf(as)).companybot.access.find((x) => x.id === "memory.remember_for_team");
		expect((await tool(owner))?.visible).toBe(true);
		expect((await tool(member))?.visible).toBe(false);
	});
});

describe("chat", () => {
	it("allows one reply at a time per conversation", async () => {
		const { owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		await owner.mutation(api.chat.send, { agentId: companybot._id, text: "hi" });
		await expect(owner.mutation(api.chat.send, { agentId: companybot._id, text: "again" })).rejects.toThrow(
			"Still replying",
		);
		// Other agents have their own conversation.
		await owner.mutation(api.chat.send, { agentId: scribe._id, text: "hi" });
		const messages = await owner.query(api.chat.messages, { agentId: companybot._id });
		expect(messages.map((m) => [m.role, m.status])).toEqual([
			["user", "done"],
			["assistant", "streaming"],
		]);
	});
});
