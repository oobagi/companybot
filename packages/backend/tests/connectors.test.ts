import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { decrypt } from "../convex/crypto";

import { workspaceOf, agentTurn, generalOf, agentsOf, ownerAndMember, settle } from "./helpers";
import "./connectorFixtures";

afterEach(() => void vi.useRealTimers());

describe("connectors", () => {
	it("lets only owners install, and members connect their own account", async () => {
		const { t, owner, member } = await ownerAndMember();
		await expect(member.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: true })).rejects.toThrow(
			"Only people with the",
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
		await expect(member.action(api.connectors.connect, { connectorId: "crm", credentials: creds })).rejects.toThrow("Only people with the");
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

		const memberId = member.userId;
		const workspaceId = await workspaceOf(owner);
		const forTurn = () => t.query(internal.connectors.forTurn, { userId: memberId, workspaceId, connectorIds: ["crm"] });
		expect(await forTurn()).toHaveLength(1);
		expect((await agentsOf(member)).scribe.access).toEqual([{ id: "crm.*", visible: true }]);

		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [] });
		expect(await forTurn()).toHaveLength(0);
		expect((await agentsOf(member)).scribe.access).toEqual([{ id: "crm.*", visible: false, reason: "role" }]);
		// Owners always can, whatever's picked.
		expect(await t.query(internal.connectors.forTurn, { userId: owner.userId, workspaceId, connectorIds: ["crm"] })).toHaveLength(1);
	});

	it("rejects a stale role switch without restoring a revoked connector grant", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		const roles = (await owner.query(api.roles.list))!;
		const memberRole = roles.find(role => role.builtIn === "member")!.id;
		const ownerRole = roles.find(role => role.builtIn === "owner")!.id;
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		const initial = (await owner.query(api.connectors.list)).find(connector => connector.id === "crm")!.roles;
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [] });
		await expect(owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [memberRole, office], expectedRoles: initial })).rejects.toThrow("access changed. Reload");
		expect((await member.query(api.connectors.list)).find(connector => connector.id === "crm")).toMatchObject({ roles: [], canUse: false });
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [office, ownerRole], expectedRoles: [] });
		// Compare the actual client-facing list; owner access remains implicit regardless of it.
		const fresh = (await owner.query(api.connectors.list)).find(connector => connector.id === "crm")!;
		expect(fresh).toMatchObject({ canUse: true });
		await owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [office], expectedRoles: [...fresh.roles].reverse().concat(fresh.roles) });
		expect((await owner.query(api.connectors.list)).find(connector => connector.id === "crm")!.roles).toEqual([office]);
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


it("personal connector data records a one-person source before results or metadata reach the model", async () => {
	vi.useFakeTimers();
	const { t, owner, member } = await ownerAndMember();
	const { companybot } = await agentsOf(owner);
	const chat = await generalOf(owner);
	for (const connectorId of ["notes", "crm"]) {
		await owner.mutation(api.connectors.setInstalled, { connectorId, installed: true });
		await owner.action(api.connectors.connect, { connectorId, credentials: { type: "api_key", key: "fixture-key" } });
	}
	const turnId = await agentTurn(t, owner, chat._id, companybot._id);
	const replyId = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
	expect(await t.mutation(internal.connectors.forCall, { turnId, connectorId: "crm" })).not.toBeNull();
	expect((await t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces ?? []).not.toContain(owner.userId);
	expect(await t.mutation(internal.connectors.forCall, { turnId, connectorId: "notes" })).not.toBeNull();
	expect((await t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces).toContain(owner.userId);
	await t.mutation(internal.turns.updateReply, { turnId, text: "PERSONAL_NOTES_SECRET", parts: [{ type: "text", text: "PERSONAL_NOTES_SECRET" }] });
	const shown = (await member.query(api.messages.list, { chatId: chat._id })).find((m) => m._id === replyId)!;
	expect(shown.privacy?.hidden).toBe(true);
	expect(JSON.stringify(shown)).not.toContain("PERSONAL_NOTES_SECRET");
	await expect(t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: "PERSONAL_NOTES_SECRET" })).rejects.toThrow("wider audience");
	expect(JSON.stringify(await member.query(api.memory.list))).not.toContain("PERSONAL_NOTES_SECRET");
	const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const ownTurn = await agentTurn(t, owner, dm, companybot._id);
	expect(await t.mutation(internal.connectors.forCall, { turnId: ownTurn, connectorId: "notes" })).not.toBeNull();
	await expect(t.mutation(internal.memory.createFor, { turnId: ownTurn, scope: "workspace", content: "PERSONAL_NOTES_SECRET" })).resolves.toHaveProperty("id");
	expect(JSON.stringify(await member.query(api.memory.list))).toContain("PERSONAL_NOTES_SECRET");
	await owner.mutation(api.connectors.disconnect, { connectorId: "notes" });
	expect(await t.mutation(internal.connectors.forCall, { turnId, connectorId: "notes" })).toBeNull();
});
