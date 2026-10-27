import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { decrypt } from "../convex/crypto";

import { workspaceOf, agentsOf, setup as ownerAndMember, settle } from "./helpers";
import "./connectorFixtures";

afterEach(() => void vi.useRealTimers());

describe("connectors", () => {
	it("lets only owners install, and members connect their own account", async () => {
		const { t, owner, member } = await ownerAndMember();
		await expect(member.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: true })).rejects.toThrow(
			"permission",
		);
		await expect(
			member.action(api.connectors.connect, { connectorId: "notes", credentials: { type: "api_key", key: "k" } }),
		).rejects.toThrow("Install the connector first");
		await owner.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: true });
		await member.action(api.connectors.connect, { connectorId: "notes", credentials: { type: "api_key", key: "secret-1" } });

		const mine = (await member.query(api.connectors.list)).find((p) => p.id === "notes")!;
		expect(mine).toMatchObject({ installed: true, connected: true, canUse: true });
		expect(JSON.stringify(mine)).not.toContain("secret-1");
		// Personal: the owner hasn't connected their own account.
		expect((await owner.query(api.connectors.list)).find((p) => p.id === "notes")?.connected).toBe(false);

		const stored = await t.run((ctx) => ctx.db.query("connectorConnections").first());
		expect(stored?.credentials).not.toContain("secret-1");
		expect(await decrypt(stored!.credentials)).toEqual({ type: "api_key", key: "secret-1" });
	});

	it("needs an owner to connect a workspace account", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		const creds = { type: "api_key" as const, key: "k" };
		await expect(member.action(api.connectors.connect, { connectorId: "crm", credentials: creds })).rejects.toThrow("permission");
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: creds });
		// One shared connection covers everyone.
		expect((await member.query(api.connectors.list)).find((p) => p.id === "crm")?.connected).toBe(true);
	});

	it("gives agents connector tools only for allowed roles, read fresh each turn", async () => {
		const { t, owner, member } = await ownerAndMember();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "k" } });
		const { scribe } = await agentsOf(owner);
		const config = { name: "Scribe", description: "", instructions: "", model: scribe.model, tools: ["crm.*"] };
		await owner.mutation(api.agents.update, { agentId: scribe._id, expectedVersion: 1, config });

		const memberId = (await member.query(api.workspace.me))!.userId;
		const workspaceId = await workspaceOf(owner);
		const forTurn = () => t.query(internal.connectors.forTurn, { userId: memberId, workspaceId, connectorIds: ["crm"] });
		expect(await forTurn()).toHaveLength(1);
		expect((await agentsOf(member)).scribe.access).toEqual([{ id: "crm.*", visible: true }]);

		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: ["owner"] });
		expect(await forTurn()).toHaveLength(0);
		expect((await agentsOf(member)).scribe.access).toEqual([{ id: "crm.*", visible: false, reason: "role" }]);
	});

	it("forgets connections when uninstalled", async () => {
		const { t, owner } = await ownerAndMember();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "k" } });
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: false });
		expect((await owner.query(api.connectors.list)).find((c) => c.id === "crm")).toMatchObject({ installed: false, connected: false });
		// Reinstalling waits until the old accounts are gone, so none come back.
		await expect(owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true })).rejects.toThrow("still being uninstalled");
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("connectorConnections").collect())).toHaveLength(0);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
	});
});
