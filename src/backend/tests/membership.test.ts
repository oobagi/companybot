import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";

import { type As, agentsOf, inWorkspace, setup as ownerAndMember, sideWorkspace } from "./helpers";
import "./connectorFixtures";

afterEach(() => void vi.useRealTimers());

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

	async function removeAndRejoin(t: Awaited<ReturnType<typeof ownerAndMember>>) {
		const { owner, member } = t;
		const row = (await owner.query(api.workspace.team))!.members.find((m) => !m.isYou)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
		await member.mutation(api.workspace.acceptInvite, { id: (await member.query(api.workspace.mine))!.invitations[0]!.id });
	}

	it("forgets their personal connector accounts on removal, here only", async () => {
		const setup = await ownerAndMember();
		const { t, owner, member } = setup;
		const key = { type: "api_key" as const, key: "k" };
		await owner.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: true });
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await member.action(api.connectors.connect, { connectorId: "notes", credentials: key });
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: key });
		const side = inWorkspace(member, (await sideWorkspace(t, "member@co.com")).workspaceId);
		await side.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: true });
		await side.action(api.connectors.connect, { connectorId: "notes", credentials: key });

		await removeAndRejoin(setup);
		const connected = async (as: As, id: string) => (await as.query(api.connectors.list)).find((c) => c.id === id)?.connected;
		expect(await connected(member, "notes")).toBe(false);
		// The workspace's own account stays, and so does theirs in another workspace.
		expect(await connected(member, "crm")).toBe(true);
		expect(await connected(side, "notes")).toBe(true);
		expect(await t.run((ctx) => ctx.db.query("connectorConnections").collect())).toHaveLength(2);
	});

	it("removes automations only they could see, and their webhook stops answering", async () => {
		const setup = await ownerAndMember();
		const { t, owner, member } = setup;
		const { companybot } = await agentsOf(member);
		const make = (name: string, audience: "creator" | "subscribers") =>
			member.mutation(api.automations.create, {
				config: { name, prompt: "Act on it.", trigger: { type: "webhook" } },
				agentId: companybot._id,
				audience,
				timeZone: "UTC",
			});
		const mine = await make("Mine", "creator");
		const shared = await make("Shared", "subscribers");
		const token = (await member.query(api.automations.list)).find((a) => a.id === mine)!.webhookUrl!.split("/").at(-1)!;
		await t.fetch(`/automations/${token}`, { method: "POST", body: JSON.stringify({ id: "e1" }) });

		vi.useFakeTimers();
		await removeAndRejoin(setup);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect((await t.fetch(`/automations/${token}`, { method: "POST", body: JSON.stringify({ id: "e2" }) })).status).toBe(404);
		expect((await member.query(api.automations.list)).filter((a) => a.custom).map((a) => a.id)).toEqual([shared]);
		expect((await owner.query(api.automations.list)).filter((a) => a.custom).map((a) => a.id)).toEqual([shared]);
		expect(await t.run((ctx) => ctx.db.query("automationEvents").collect())).toHaveLength(0);
	});
});
