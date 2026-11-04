import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { ownerAndMember } from "./helpers";

it("rejects invalid explicit names without creating an agent or version", async () => {
	const { t, owner } = await ownerAndMember();
	const before = await t.run(async (ctx) => ({ agents: (await ctx.db.query("agents").collect()).length, versions: (await ctx.db.query("agentVersions").collect()).length }));
	await expect(owner.mutation(api.agents.create, { name: "   " })).rejects.toThrow("Give the agent a name.");
	await expect(owner.mutation(api.agents.create, { name: "a".repeat(41) })).rejects.toThrow("Keep the name under 40 characters.");
	expect(await t.run(async (ctx) => ({ agents: (await ctx.db.query("agents").collect()).length, versions: (await ctx.db.query("agentVersions").collect()).length }))).toEqual(before);
});

it("creates the trimmed name and initial version atomically, preserving legacy defaults", async () => {
	const { t, owner, member } = await ownerAndMember();
	const id = await owner.mutation(api.agents.create, { name: "  Project assistant  " });
	const saved = await t.run(async (ctx) => ({ agent: await ctx.db.get(id), versions: await ctx.db.query("agentVersions").withIndex("by_agent", (q) => q.eq("agentId", id)).collect() }));
	expect(saved.agent).toMatchObject({ name: "Project assistant", version: 1 });
	expect(saved.versions).toHaveLength(1);
	expect(saved.versions[0]).toMatchObject({ version: 1, config: { name: "Project assistant" } });
	const legacy = await owner.mutation(api.agents.create, {});
	expect(await t.run((ctx) => ctx.db.get(legacy))).toMatchObject({ name: "New agent", version: 1 });
	await expect(member.mutation(api.agents.create, { name: "Unauthorized" })).rejects.toThrow();
});
