import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";

import { newTest, signIn, agentsOf, ownerAndMember } from "./helpers";

afterEach(() => void vi.useRealTimers());

describe("agents", () => {
	it("gives new workspaces the default agents", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		expect((await agentsOf(owner)).list.map((a) => a.name)).toEqual(["Companybot"]);
		for (const query of [api.recordTypes.list, api.skills.list, api.automations.list]) expect(await owner.query(query)).toEqual([]);
		expect((await owner.query(api.chats.list))!.channels.map((c) => c.title)).toEqual(["general"]);
		for (const table of ["pages", "records", "skillInstalls", "automationInstalls", "connectorInstalls"] as const)
			expect(await t.run((ctx) => ctx.db.query(table).collect())).toEqual([]);
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

	it("saves old desktop configs and restores history containing retired connector grants", async () => {
		const { t, owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const config = { name: scribe.name, description: scribe.description, instructions: scribe.instructions, model: scribe.model, tools: [...scribe.tools, "night-owl.*", "night-owl.search"] };
		await t.run(async (ctx) => {
			const version = await ctx.db.query("agentVersions").withIndex("by_agent", q => q.eq("agentId", scribe._id).eq("version", 1)).first();
			await ctx.db.patch(version!._id, { config });
		});
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config });
		await owner.mutation(api.agents.restore, { agentId: scribe._id, version: 1, expectedVersion: 2 });
		expect((await agentsOf(owner)).scribe.tools).toEqual([...scribe.tools].sort());
		expect((await owner.query(api.agents.history, { agentId: scribe._id })).find((v) => v.version === 1)!.config.tools).toEqual(config.tools);
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

	it("keeps alpha.7 Archive agent working through Trash, and at least one agent", async () => {
		const { owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		await owner.mutation(api.agents.setArchived, { agentId: scribe._id, archived: true });
		expect((await agentsOf(owner)).scribe.trash).toMatchObject({ kind: "agent", name: "Scribe" });
		await expect(owner.mutation(api.chats.openDm, { userIds: [], agentIds: [scribe._id] })).rejects.toThrow(
			"isn't available",
		);
		await expect(owner.mutation(api.agents.setArchived, { agentId: companybot._id, archived: true })).rejects.toThrow(
			"at least one",
		);
	});

	it("offers the fallback models until the gateway catalog is cached", async () => {
		const { owner } = await ownerAndMember();
		expect(await owner.query(api.agents.options)).toMatchObject({ fetchedAt: null, defaultModel: "openai/gpt-6-luna" });
		expect((await owner.query(api.agents.options)).models.map((m) => m.id)).toContain("anthropic/claude-sonnet-5.5");
	});

	it("accepts any cached gateway model and keeps an agent's dropped model valid", async () => {
		const { t, owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const config = { name: scribe.name, description: "", instructions: "", model: "openai/gpt-x", tools: [] as string[] };
		const save = (expectedVersion: number, model: string) => owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion, config: { ...config, model } });
		await expect(save(1, "openai/gpt-x")).rejects.toThrow("model");
		await t.mutation(internal.modelCatalog.save, { models: [{ id: "openai/gpt-x", name: "GPT X", provider: "openai", contextWindow: 400_000, input: 1.25, output: 10 }] });
		expect((await owner.query(api.agents.options)).models.map((m) => m.id)).toEqual(["openai/gpt-x"]);
		await save(1, "openai/gpt-x");
		// The gateway drops it: the agent keeps it through other edits, but can't switch back to it later.
		await t.mutation(internal.modelCatalog.save, { models: [{ id: "openai/gpt-y", name: "GPT Y", provider: "openai" }] });
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 2, config: { ...config, name: "Kept" } });
		await save(3, "anthropic/claude-haiku-5.5");
		await expect(save(4, "openai/gpt-x")).rejects.toThrow("model");
	});

	it("refreshes a stale catalog from the gateway, and keeps the old copy when it's down", async () => {
		const { t, owner } = await ownerAndMember();
		const body = { data: [
			{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", type: "language", tags: ["tool-use"], context_window: 1_000_000, pricing: { input: "0.000003", output: "0.000015" } },
			{ id: "openai/text-embedding-3", name: "Embedding", type: "embedding", tags: [] },
		] };
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
		await owner.action(api.modelCatalog.refreshIfStale);
		expect((await owner.query(api.agents.options)).models).toEqual([{ id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: "anthropic", contextWindow: 1_000_000, input: 3, output: 15 }]);
		// Fresh: no second fetch.
		await owner.action(api.modelCatalog.refreshIfStale);
		expect(fetch).toHaveBeenCalledTimes(1);
		fetch.mockResolvedValue(new Response("down", { status: 503 }));
		await expect(t.action(internal.modelCatalog.refresh)).rejects.toThrow("503");
		expect((await owner.query(api.agents.options)).models).toHaveLength(1);
		fetch.mockRestore();
	});
});
