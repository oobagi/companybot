import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { decrypt } from "../convex/crypto";
import { definePlugin, pluginCatalog } from "@companybot/core";

// A test plugin, so plugin flows can run without a real connector in the catalog.
const notes = definePlugin({
	id: "notes",
	name: "Notes",
	description: "Test plugin",
	version: "1.0.0",
	publisher: "Test",
	mcp: { url: "https://example.com/mcp", transport: "http" },
	connection: "personal",
	auth: { type: "api_key", header: "Authorization", prefix: "Bearer ", label: "API key" },
});
const crm = definePlugin({ ...notes, id: "crm", name: "CRM", connection: "workspace" });
pluginCatalog.push(notes, crm);
process.env.CONNECTIONS_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

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
			"permission",
		);
	});

	it("doesn't invite people who are already in", async () => {
		const { owner } = await ownerAndMember();
		await expect(owner.mutation(api.workspace.invite, { email: "MEMBER@co.com", role: "owner" })).rejects.toThrow(
			"already a member",
		);
		await owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		await expect(owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" })).rejects.toThrow(
			"already has an invite",
		);
	});
});

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

	it("lets agents fix and forget only what the person could", async () => {
		const { t, owner, member } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const team = await owner.mutation(api.memory.create, { agentId, scope: "workspace", content: "Office is in Austin." });
		const memberId = (await member.query(api.workspace.me))!.userId;
		const id = team.id as never;
		await expect(t.mutation(internal.memory.removeFor, { userId: memberId, agentId, id })).rejects.toThrow("can't change");
		await expect(
			t.mutation(internal.memory.updateFor, { userId: memberId, agentId: (await agentsOf(owner)).scribe._id, id, content: "x" }),
		).rejects.toThrow("not found");
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
			"permission",
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
			"permission",
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

describe("reply stats and compaction", () => {
	const usage = (costUsd: number) => ({
		model: "anthropic/claude-haiku-5.5",
		steps: 1,
		inputTokens: 100,
		cachedInputTokens: 0,
		outputTokens: 20,
		contextTokens: 120,
		costUsd,
		durationMs: 900,
	});

	/** Sends a message and finishes the reply as the runner would. */
	async function exchange(t: ReturnType<typeof convexTest>, as: Awaited<ReturnType<typeof signIn>>, agentId: Id<"agents">, cost: number) {
		await as.mutation(api.chat.send, { agentId, text: "hi" });
		const reply = (await as.query(api.chat.messages, { agentId })).at(-1)!;
		await t.mutation(internal.chat.finishReply, { conversationId: reply.conversationId, replyId: reply._id, usage: usage(cost) });
		return reply.conversationId;
	}

	it("keeps each reply's cost and the running total", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		await exchange(t, owner, companybot._id, 0.01);
		await exchange(t, owner, companybot._id, 0.02);
		const stats = (await owner.query(api.chat.messages, { agentId: companybot._id })).flatMap((m) => (m.stats ? [m.stats] : []));
		expect(stats.map((s) => [s.costUsd, s.conversationCostUsd])).toEqual([
			[0.01, 0.01],
			[0.02, 0.03],
		]);
	});

	it("folds older messages, adds the summary's cost, and shows compacting meanwhile", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		let conversationId!: Id<"conversations">;
		for (let i = 0; i < 3; i++) conversationId = await exchange(t, owner, companybot._id, 0.01);

		const input = await t.mutation(internal.chat.startCompaction, { conversationId, keep: 2 });
		expect(input?.messages).toHaveLength(4);
		expect((await owner.query(api.chat.conversation, { agentId: companybot._id }))?.compacting).toBe(true);
		// A second compaction can't start while one runs.
		expect(await t.mutation(internal.chat.startCompaction, { conversationId, keep: 2 })).toBeNull();

		await t.mutation(internal.chat.finishCompaction, {
			conversationId,
			result: { summary: "- Said hi", upTo: input!.upTo, costUsd: 0.005 },
		});
		const conversation = await owner.query(api.chat.conversation, { agentId: companybot._id });
		expect(conversation).toMatchObject({ summary: "- Said hi", summarizedUpTo: input!.upTo, compacting: false });
		expect(conversation?.costUsd).toBeCloseTo(0.035);
	});

	it("clears compacting when the summary fails, changing nothing else", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const conversationId = await exchange(t, owner, companybot._id, 0.01);
		await exchange(t, owner, companybot._id, 0.01);
		await t.mutation(internal.chat.startCompaction, { conversationId, keep: 1 });
		await t.mutation(internal.chat.finishCompaction, { conversationId });
		expect(await owner.query(api.chat.conversation, { agentId: companybot._id })).toMatchObject({
			summary: null,
			compacting: false,
		});
	});
});

describe("plugins", () => {
	it("lets only owners install, and members connect their own account", async () => {
		const { t, owner, member } = await ownerAndMember();
		await expect(member.mutation(api.plugins.setInstalled, { pluginId: "notes", installed: true })).rejects.toThrow(
			"permission",
		);
		await expect(
			member.action(api.plugins.connect, { pluginId: "notes", credentials: { type: "api_key", key: "k" } }),
		).rejects.toThrow("Install the plugin first");
		await owner.mutation(api.plugins.setInstalled, { pluginId: "notes", installed: true });
		await member.action(api.plugins.connect, { pluginId: "notes", credentials: { type: "api_key", key: "secret-1" } });

		const mine = (await member.query(api.plugins.list)).find((p) => p.id === "notes")!;
		expect(mine).toMatchObject({ installed: true, connected: true, canUse: true });
		expect(JSON.stringify(mine)).not.toContain("secret-1");
		// Personal: the owner hasn't connected their own account.
		expect((await owner.query(api.plugins.list)).find((p) => p.id === "notes")?.connected).toBe(false);

		const stored = await t.run((ctx) => ctx.db.query("pluginConnections").first());
		expect(stored?.credentials).not.toContain("secret-1");
		expect(await decrypt(stored!.credentials)).toEqual({ type: "api_key", key: "secret-1" });
	});

	it("needs an owner to connect a workspace account", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.plugins.setInstalled, { pluginId: "crm", installed: true });
		const creds = { type: "api_key" as const, key: "k" };
		await expect(member.action(api.plugins.connect, { pluginId: "crm", credentials: creds })).rejects.toThrow("permission");
		await owner.action(api.plugins.connect, { pluginId: "crm", credentials: creds });
		// One shared connection covers everyone.
		expect((await member.query(api.plugins.list)).find((p) => p.id === "crm")?.connected).toBe(true);
	});

	it("gives agents plugin tools only for allowed roles, read fresh each turn", async () => {
		const { t, owner, member } = await ownerAndMember();
		await owner.mutation(api.plugins.setInstalled, { pluginId: "crm", installed: true });
		await owner.action(api.plugins.connect, { pluginId: "crm", credentials: { type: "api_key", key: "k" } });
		const { scribe } = await agentsOf(owner);
		const config = { name: "Scribe", description: "", instructions: "", model: scribe.model, tools: ["crm.*"] };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config });

		const memberId = (await member.query(api.workspace.me))!.userId;
		const forTurn = () => t.query(internal.plugins.forTurn, { userId: memberId, pluginIds: ["crm"] });
		expect(await forTurn()).toHaveLength(1);
		expect((await agentsOf(member)).scribe.access).toEqual([{ id: "crm.*", visible: true }]);

		await owner.mutation(api.plugins.setRoles, { pluginId: "crm", roles: ["owner"] });
		expect(await forTurn()).toHaveLength(0);
		expect((await agentsOf(member)).scribe.access).toEqual([{ id: "crm.*", visible: false, reason: "role" }]);
	});

	it("forgets connections when uninstalled", async () => {
		const { t, owner } = await ownerAndMember();
		await owner.mutation(api.plugins.setInstalled, { pluginId: "crm", installed: true });
		await owner.action(api.plugins.connect, { pluginId: "crm", credentials: { type: "api_key", key: "k" } });
		await owner.mutation(api.plugins.setInstalled, { pluginId: "crm", installed: false });
		expect(await t.run((ctx) => ctx.db.query("pluginConnections").collect())).toHaveLength(0);
	});
});
