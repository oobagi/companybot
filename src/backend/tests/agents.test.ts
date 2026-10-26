import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";

import { agentsOf, setup as ownerAndMember } from "./helpers";

afterEach(() => void vi.useRealTimers());

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
		await expect(owner.mutation(api.chats.openDm, { userIds: [], agentIds: [scribe._id] })).rejects.toThrow(
			"isn't available",
		);
		await expect(owner.mutation(api.agents.setArchived, { agentId: companybot._id, archived: true })).rejects.toThrow(
			"at least one",
		);
	});
});
