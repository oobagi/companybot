import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { person } from "./person";
import { decrypt } from "../convex/crypto";
import {
	APPROVAL_TTL_MS,
	DOWNLOAD_URL,
	INVITE_EMAILS_PER_DAY,
	inviteEmail,
	approvalHash,
	automationCatalog,
	builtinTools,
	canonicalJson,
	connectorCatalog,
	defineAutomation,
	defineConnector,
	systemPrompt,
} from "@companybot/core";

// A test connector, so connector flows can run without a real connector in the catalog.
const notes = defineConnector({
	id: "notes",
	name: "Notes",
	description: "Test connector",
	version: "1.0.0",
	publisher: "Test",
	mcp: { url: "https://example.com/mcp", transport: "http" },
	connection: "personal",
	auth: { type: "api_key", header: "Authorization", prefix: "Bearer ", label: "API key" },
});
const crm = defineConnector({ ...notes, id: "crm", name: "CRM", connection: "workspace" });
connectorCatalog.push(notes, crm);
// An automation that needs a connector, for the install check.
automationCatalog.push(
	defineAutomation({ ...automationCatalog[0]!, id: "crm-digest", name: "CRM digest", connectors: ["crm"] }),
);
process.env.CONNECTIONS_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/_generated/*.js"]);

/** A signed-in person. Convex Auth reads the user id from the token subject. */
async function signIn(t: ReturnType<typeof convexTest>, email: string) {
	const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
	const as = person(t.withIdentity({ subject: `${userId}|session` }));
	await as.mutation(api.workspace.ensure);
	return as;
}

/** The workspace a person's calls act in when they name none (older apps): their first. */
const workspaceOf = async (as: Awaited<ReturnType<typeof signIn>>) => (await as.query(api.workspace.me))!.workspaceId!;

/** A person's calls as the app makes them: each carries the workspace that window has open. */
const inWorkspace = (as: Awaited<ReturnType<typeof signIn>>, workspaceId: Id<"workspaces">) => as.in(workspaceId);

/** Gives someone a second workspace of their own, as owner. */
async function sideWorkspace(t: ReturnType<typeof convexTest>, email: string, name = "Side gig") {
	return t.run(async (ctx) => {
		const userId = (await ctx.db.query("users").collect()).find((u) => u.email === email)!._id;
		const workspaceId = await ctx.db.insert("workspaces", { name, version: 1 });
		await ctx.db.insert("members", { workspaceId, userId, role: "owner" });
		return { userId, workspaceId };
	});
}

/** The workspace's agents by name. */
async function agentsOf(as: Awaited<ReturnType<typeof signIn>>) {
	const list = await as.query(api.agents.list);
	const byName = (name: string) => list.find((a) => a.name === name)!;
	return { list, companybot: byName("Companybot"), scribe: byName("Scribe") };
}

async function ownerAndMember() {
	const t = convexTest({ schema, modules, transactionLimits: true });
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

describe("invites", () => {
	const sent = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("inviteEmails").collect());

	it("emails the invite, saying who invited them, and lets owners resend or cancel it", async () => {
		const { t, owner, member } = await ownerAndMember();
		await owner.mutation(api.preferences.update, { displayName: "Jaden" });
		await owner.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: 1 });
		await owner.mutation(api.workspace.invite, { email: "Pal@Co.com", role: "member" });
		expect((await sent(t)).map((e) => e.email)).toEqual(["member@co.com", "pal@co.com"]);
		const invite = (await owner.query(api.workspace.team))!.invites[0]!;
		await expect(member.mutation(api.workspace.resendInvite, { id: invite.id })).rejects.toThrow("permission");

		// The same address can't be emailed again right away.
		await expect(owner.mutation(api.workspace.resendInvite, { id: invite.id })).rejects.toThrow("a moment ago");
		vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ["Date"] });
		await owner.mutation(api.workspace.resendInvite, { id: invite.id });
		vi.useRealTimers();
		expect(await sent(t)).toHaveLength(3);

		await owner.mutation(api.workspace.cancelInvite, { id: invite.id });
		expect((await owner.query(api.workspace.team))!.invites).toEqual([]);
		// Cancelling and inviting again doesn't get around the wait: the invite is saved, the email isn't sent.
		expect(await owner.mutation(api.workspace.invite, { email: "pal@co.com", role: "member" })).toEqual({ emailed: false });
		expect(await sent(t)).toHaveLength(3);
		expect(inviteEmail({ inviter: "Eve\r\nBcc: x@evil.com", workspace: "Acme\n", email: "pal@co.com" }).subject).toBe(
			"Eve Bcc: x@evil.com invited you to Acme on Companybot",
		);
		expect(inviteEmail({ inviter: "Jaden", workspace: "Acme", email: "pal@co.com" })).toMatchObject({
			subject: "Jaden invited you to Acme on Companybot",
			text: expect.stringContaining(DOWNLOAD_URL),
		});
	});

	it("caps invite emails per workspace per day", async () => {
		const { t, owner } = await ownerAndMember();
		for (let i = 1; i < INVITE_EMAILS_PER_DAY; i++) await owner.mutation(api.workspace.invite, { email: `p${i}@co.com`, role: "member" });
		await expect(owner.mutation(api.workspace.invite, { email: "one-more@co.com", role: "member" })).rejects.toThrow("Try again tomorrow");
		// Refused invites aren't saved half-done.
		expect((await owner.query(api.workspace.team))!.invites).toHaveLength(INVITE_EMAILS_PER_DAY - 1);
		expect(await sent(t)).toHaveLength(INVITE_EMAILS_PER_DAY);
	});

	it("lets someone who already has a workspace accept, then switch between both", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const owner = await signIn(t, "owner@co.com");
		await owner.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: 1 });
		const pal = await signIn(t, "pal@co.com");
		const palsOwn = await workspaceOf(pal);
		await owner.mutation(api.workspace.invite, { email: "pal@co.com", role: "member" });
		// Another workspace inviting the same email doesn't block this one.
		const other = await signIn(t, "other@co.com");
		await other.mutation(api.workspace.invite, { email: "pal@co.com", role: "owner" });

		const mine = (await pal.query(api.workspace.mine))!;
		expect(mine.workspaces.map((w) => w.name)).toEqual(["My company"]);
		expect(mine.invitations.map((i) => i.workspace).sort()).toEqual(["Acme", "My company"]);
		const acme = mine.invitations.find((i) => i.workspace === "Acme")!;
		// Only the person invited can use it.
		await expect(other.mutation(api.workspace.acceptInvite, { id: acme.id })).rejects.toThrow("isn't available");

		const acmeId = await pal.mutation(api.workspace.acceptInvite, { id: acme.id });
		expect((await pal.query(api.workspace.mine))!.lastUsed).toBe(acmeId);
		const inAcme = inWorkspace(pal, acmeId);
		expect(await inAcme.query(api.workspace.me)).toMatchObject({ workspace: "Acme", role: "member" });
		expect((await inAcme.query(api.chats.list))!.channels[0]!.members).toHaveLength(2);
		await pal.mutation(api.workspace.declineInvite, { id: mine.invitations.find((i) => i.workspace !== "Acme")!.id });
		expect((await pal.query(api.workspace.mine))!.invitations).toEqual([]);

		await pal.mutation(api.workspace.switchTo, { to: palsOwn });
		expect((await pal.query(api.workspace.mine))!.lastUsed).toBe(palsOwn);
		expect(await inWorkspace(pal, palsOwn).query(api.workspace.me)).toMatchObject({ workspace: "My company", role: "owner" });
		await expect(pal.mutation(api.workspace.switchTo, { to: await workspaceOf(other) })).rejects.toThrow("not in that workspace");
	});

	it("joins every workspace that invited someone new", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const a = await signIn(t, "a@co.com");
		const b = await signIn(t, "b@co.com");
		await a.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		await b.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		const fresh = await signIn(t, "new@co.com");
		expect((await fresh.query(api.workspace.mine))!.workspaces).toHaveLength(2);
		expect((await a.query(api.workspace.team))!.members).toHaveLength(2);
	});

	it("acts in the workspace each request names, whatever another device has open", async () => {
		const { t, owner } = await ownerAndMember();
		const acme = await workspaceOf(owner);
		const side = (await sideWorkspace(t, "owner@co.com")).workspaceId;
		// Another device switches to the side workspace...
		await owner.mutation(api.workspace.switchTo, { to: side });
		// ...while this one, with Acme open, saves settings and invites someone.
		const here = inWorkspace(owner, acme);
		const { version } = (await here.query(api.workspace.settings))!;
		await here.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: version });
		await here.mutation(api.workspace.invite, { email: "new@co.com", role: "owner" });
		const names = await t.run(async (ctx) => [(await ctx.db.get(acme))!.name, (await ctx.db.get(side))!.name]);
		expect(names).toEqual(["Acme", "Side gig"]);
		const invites = await t.run((ctx) => ctx.db.query("invites").filter((q) => q.eq(q.field("email"), "new@co.com")).collect());
		expect(invites.map((i) => i.workspaceId)).toEqual([acme]);
		expect((await inWorkspace(owner, side).query(api.workspace.team))!.invites).toEqual([]);
	});

	it("refuses a request for a workspace the person isn't in", async () => {
		const { t, member } = await ownerAndMember();
		const stranger = await signIn(t, "stranger@co.com");
		const theirs = inWorkspace(member, await workspaceOf(stranger));
		expect(await theirs.query(api.workspace.me)).toMatchObject({ role: null });
		expect(await theirs.query(api.chats.list)).toBeNull();
		expect(await theirs.query(api.workspace.team)).toBeNull();
		await expect(theirs.mutation(api.chats.createChannel, { name: "mine-now", private: false })).rejects.toThrow("Sign in to a workspace");
		await expect(theirs.mutation(api.workspace.updateSettings, { name: "Taken", expectedVersion: 1 })).rejects.toThrow();
	});

	it("keeps older apps, which name no workspace, in the first one the person joined", async () => {
		const { t, member } = await ownerAndMember();
		const acme = await workspaceOf(member);
		const side = (await sideWorkspace(t, "member@co.com")).workspaceId;
		await member.mutation(api.workspace.switchTo, { to: side });
		expect(await member.query(api.workspace.me)).toMatchObject({ workspaceId: acme, role: "member" });
		await member.mutation(api.workspace.switchTo, { to: acme });
		await member.mutation(api.workspace.switchTo, { to: side });
		expect((await member.query(api.workspace.me))!.workspaceId).toBe(acme);
	});

	it("lets people leave, but not the last owner, and removal ends access at once", async () => {
		const { owner, member } = await ownerAndMember();
		await expect(owner.mutation(api.workspace.leave)).rejects.toThrow("only owner");
		const secret = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		const memberId = await meOf(member);
		await owner.mutation(api.chats.addMembers, { chatId: secret, userIds: [memberId], agentIds: [] });
		const dm = await owner.mutation(api.chats.openDm, { userIds: [memberId], agentIds: [] });
		expect(await member.query(api.chats.get, { chatId: secret })).not.toBeNull();

		const row = (await owner.query(api.workspace.team))!.members.find((m) => !m.isYou)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		expect(await member.query(api.chats.get, { chatId: secret })).toBeNull();
		await expect(member.mutation(api.messages.send, { chatId: dm, text: "still here?", mentions: noMentions })).rejects.toThrow();
		// Their seat in channels is gone, so rejoining doesn't bring back private ones; DMs keep them listed.
		expect((await owner.query(api.chats.get, { chatId: secret }))!.members).toHaveLength(1);
		expect((await owner.query(api.chats.get, { chatId: dm }))!.members).toHaveLength(2);
		await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
		await member.mutation(api.workspace.ensure);
		expect(await member.query(api.chats.get, { chatId: secret })).toBeNull();

		await member.mutation(api.workspace.leave);
		expect((await owner.query(api.workspace.team))!.members).toHaveLength(1);
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
		await expect(t.mutation(internal.memory.updateFor, { turnId: scribeTurn, id, content: "x" })).rejects.toThrow("not found");
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
		expect(await owner.query(api.preferences.get)).toEqual({
			displayName: "Jaden",
			sendWith: "mod-enter",
			notify: "all",
			timeZone: null,
			deviceTimeZone: null,
		});
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

	describe("skills people make", () => {
		const quote = {
			name: "Quote follow-up",
			description: "Chase a quote nobody answered. Use when asked to follow up on a quote.",
			instructions: "Write one short reminder and one question that moves it forward.",
		};

		async function made() {
			const ctx = await ownerAndMember();
			const skillId = await ctx.owner.mutation(api.skills.create, { config: quote });
			const find = async (as = ctx.owner) => (await as.query(api.skills.list)).find((s) => s.id === skillId);
			return { ...ctx, skillId, find };
		}

		it("lets anyone make one, on for the whole workspace", async () => {
			const { member, skillId, find } = await made();
			expect(skillId).toMatch(/^custom-[0-9a-f]{12}$/);
			const list = await member.query(api.skills.list);
			expect(list[0]).toMatchObject({ id: skillId, name: "Quote follow-up", installed: true, version: "1", canEdit: false });
			expect((await find(member))?.custom).toMatchObject({ version: 1, updatedByName: "owner@co.com" });
			expect(list.filter((s) => s.custom)).toHaveLength(1);
			const mine = await member.mutation(api.skills.create, { config: { ...quote, name: "Mine" } });
			expect((await member.query(api.skills.list)).find((s) => s.id === mine)).toMatchObject({
				canEdit: true,
				createdByName: "member@co.com",
			});
		});

		it("lets the maker or an owner change or delete it, nobody else", async () => {
			const { owner, member } = await made();
			const skillId = await member.mutation(api.skills.create, { config: quote });
			const config = { ...quote, description: "Mine now." };
			await member.mutation(api.skills.save, { skillId, config, expectedVersion: 1 });
			await owner.mutation(api.skills.save, { skillId, config: quote, expectedVersion: 2 });
			const row = (await member.query(api.skills.list)).find((s) => s.id === skillId);
			expect(row).toMatchObject({ canEdit: true, createdByName: "member@co.com", custom: { version: 3, updatedByName: "owner@co.com" } });
			await owner.mutation(api.skills.setInstalled, { skillId, installed: false });
			expect((await member.query(api.skills.list)).some((s) => s.id === skillId)).toBe(false);
			await expect(member.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true })).rejects.toThrow("permission");
		});

		it("removes custom skills for their maker or an owner, and library skills for owners", async () => {
			const { t, owner, member, skillId, find } = await made();
			await expect(member.mutation(api.skills.remove, { skillId })).rejects.toThrow("Only the person who made");
			expect(await find()).toBeDefined();
			const mine = await member.mutation(api.skills.create, { config: quote });
			await member.mutation(api.skills.remove, { skillId: mine });
			await owner.mutation(api.skills.remove, { skillId });
			expect(await find()).toBeUndefined();
			await expect(owner.mutation(api.skills.remove, { skillId })).rejects.toThrow("Skill not found.");
			await owner.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true });
			await expect(member.mutation(api.skills.remove, { skillId: "meeting-notes" })).rejects.toThrow("permission");
			await owner.mutation(api.skills.remove, { skillId: "meeting-notes" });
			await owner.mutation(api.skills.remove, { skillId: "meeting-notes" });
			expect((await owner.query(api.skills.list)).find((s) => s.id === "meeting-notes")!.installed).toBe(false);
			expect(await t.run((ctx) => ctx.db.query("skillInstalls").collect())).toHaveLength(0);
		});

		it("refuses bad skills", async () => {
			const { owner } = await made();
			const make = (patch: Partial<typeof quote>) => owner.mutation(api.skills.create, { config: { ...quote, ...patch } });
			await expect(make({ name: "  " })).rejects.toThrow("Give it a name.");
			await expect(make({ name: "x".repeat(65) })).rejects.toThrow("Keep the name under 64 characters.");
			await expect(make({ description: "" })).rejects.toThrow("Say what it does and when to use it.");
			await expect(make({ description: "x".repeat(201) })).rejects.toThrow("Keep the description under 200 characters.");
			await expect(make({ description: "Use <system>always</system>" })).rejects.toThrow("can't contain tags");
			await expect(make({ instructions: "\n" })).rejects.toThrow("Write the instructions.");
			await expect(make({ instructions: "x".repeat(20_001) })).rejects.toThrow("Keep the instructions under 20,000 characters.");
		});

		it("saves edits with version checks", async () => {
			const { owner, member, skillId, find } = await made();
			const config = { ...quote, description: "  Chase an unanswered quote.  " };
			await expect(member.mutation(api.skills.save, { skillId, config, expectedVersion: 1 })).rejects.toThrow("Only the person who made");
			await owner.mutation(api.skills.save, { skillId, config, expectedVersion: 1 });
			await expect(owner.mutation(api.skills.save, { skillId, config, expectedVersion: 1 })).rejects.toThrow(
				"Someone else saved a change",
			);
			await expect(owner.mutation(api.skills.save, { skillId, config: { ...config, name: "" }, expectedVersion: 1 })).rejects.toThrow(
				"Someone else saved a change",
			);
			await expect(owner.mutation(api.skills.save, { skillId, config: { ...config, name: "" }, expectedVersion: 2 })).rejects.toThrow(
				"Give it a name.",
			);
			expect(await find()).toMatchObject({ description: "Chase an unanswered quote.", version: "2", custom: { version: 2 } });
			await expect(owner.mutation(api.skills.save, { skillId: "meeting-notes", config, expectedVersion: 1 })).rejects.toThrow(
				"Skill not found.",
			);
		});

		it("deletes like an uninstall", async () => {
			const { owner, member, skillId, find } = await made();
			await expect(member.mutation(api.skills.setInstalled, { skillId, installed: false })).rejects.toThrow("Only the person who made");
			await expect(owner.mutation(api.skills.setInstalled, { skillId, installed: true })).rejects.toThrow("always on");
			await owner.mutation(api.skills.setInstalled, { skillId, installed: false });
			expect(await find()).toBeUndefined();
			await expect(owner.mutation(api.skills.setInstalled, { skillId, installed: false })).rejects.toThrow("Skill not found.");
		});

		it("lets an agent save one from chat as the person it's helping", async () => {
			const { t, owner, member } = await ownerAndMember();
			const { companybot } = await agentsOf(owner);
			await member.mutation(api.messages.send, {
				chatId: (await generalOf(member))._id,
				text: "@Companybot save how we chase quotes",
				mentions: { userIds: [], agentIds: [companybot._id] },
			});
			const turnId = (await turnsOf(t))[0]!._id;
			expect(await t.mutation(internal.skills.createFor, { turnId, config: { ...quote, name: "" } })).toEqual({ error: "Give it a name." });
			const made = (await t.mutation(internal.skills.createFor, { turnId, config: { ...quote, name: "  Quote follow-up  " } })) as { created: string; name: string };
			expect(made.name).toBe("Quote follow-up");
			expect((await member.query(api.skills.list)).find((s) => s.id === made.created)).toMatchObject({
				canEdit: true,
				createdByName: "member@co.com",
			});
		});

		it("reaches agents like a library skill: description in the prompt, full text through skills.load", async () => {
			const { t, owner, skillId } = await made();
			await owner.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true });
			const { companybot } = await agentsOf(owner);
			const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
			await owner.mutation(api.messages.send, { chatId, text: "Chase the Reyes quote", mentions: noMentions });
			const [turn] = await turnsOf(t);
			const context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
			expect(context.skills.map((s) => s.id)).toEqual(["meeting-notes", skillId]);
			expect(systemPrompt(context.agent, context.skills)).toContain(`- ${skillId}: ${quote.description}`);
			const load = builtinTools.find((x) => x.id === "skills.load")!;
			expect(await load.execute({ id: skillId }, { skills: { list: context.skills } } as never)).toEqual({ instructions: quote.instructions });
		});
	});

	it("hides owner-only tools from members", async () => {
		const { owner, member } = await ownerAndMember();
		const tool = async (as: typeof owner) =>
			(await agentsOf(as)).companybot.access.find((x) => x.id === "memory.remember_for_team");
		expect((await tool(owner))?.visible).toBe(true);
		expect((await tool(member))?.visible).toBe(false);
	});
});

type As = Awaited<ReturnType<typeof signIn>>;
const noMentions = { userIds: [], agentIds: [] };
/** Read times are in ms; let the clock move so "after" means after. */
const tick = () => new Promise((r) => setTimeout(r, 3));
const meOf = async (as: As) => (await as.query(api.workspace.me))!.userId;
const generalOf = async (as: As) => (await as.query(api.chats.list))!.channels.find((c) => c.isDefault)!;
const turnsOf = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("agentTurns").collect());
/** A running turn of `agentId` for `as`, started by mentioning it in `chatId`. Fake timers hold its reply back. */
async function agentTurn(t: ReturnType<typeof convexTest>, as: As, chatId: Id<"chats">, agentId: Id<"agents">) {
	vi.useFakeTimers();
	const before = await turnsOf(t);
	await as.mutation(api.messages.send, { chatId, text: "hi", mentions: { userIds: [], agentIds: [agentId] } });
	return (await turnsOf(t)).find((x) => !before.some((b) => b._id === x._id))!._id;
}
afterEach(() => void vi.useRealTimers());
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

describe("chats", () => {
	it("puts everyone in #general, which can't be left", async () => {
		const { owner, member } = await ownerAndMember();
		const general = await generalOf(owner);
		expect(general).toMatchObject({ name: "general", title: "general", private: false, agentId: null });
		expect(general.members.map((m) => m.type)).toEqual(["user", "user"]);
		expect((await generalOf(member))._id).toBe(general._id);
		await expect(member.mutation(api.chats.leave, { chatId: general._id })).rejects.toThrow("Everyone stays");
	});

	it("shows public channels to everyone and private ones to members only", async () => {
		const { owner, member } = await ownerAndMember();
		const open = await owner.mutation(api.chats.createChannel, { name: "  Sales Team!", private: false });
		const secret = await owner.mutation(api.chats.createChannel, { name: "#Board", private: true });
		expect((await owner.query(api.chats.get, { chatId: open }))?.name).toBe("sales-team");
		expect((await member.query(api.chats.browse)).map((c) => c.name)).toEqual(["sales-team"]);
		expect(await member.query(api.chats.get, { chatId: secret })).toBeNull();
		await owner.mutation(api.messages.send, { chatId: secret, text: "Q4 numbers", mentions: noMentions });
		expect(await member.query(api.messages.list, { chatId: secret })).toEqual([]);
		await expect(member.mutation(api.messages.send, { chatId: secret, text: "hi", mentions: noMentions })).rejects.toThrow(
			"not found",
		);
		await expect(member.mutation(api.chats.join, { chatId: secret })).rejects.toThrow("not found");

		// Posting in a public channel joins it.
		await member.mutation(api.messages.send, { chatId: open, text: "hello", mentions: noMentions });
		expect((await member.query(api.chats.list))!.channels.map((c) => c.name)).toEqual(["general", "sales-team"]);
		await expect(owner.mutation(api.chats.createChannel, { name: "sales team", private: false })).rejects.toThrow(
			"already exists",
		);
	});

	it("lets members manage only channels they created", async () => {
		const { owner, member } = await ownerAndMember();
		const theirs = await member.mutation(api.chats.createChannel, { name: "design", private: false });
		const ours = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
		await member.mutation(api.chats.updateChannel, { chatId: theirs, topic: "Pixels" });
		expect((await member.query(api.chats.get, { chatId: theirs }))?.canManage).toBe(true);
		expect((await member.query(api.chats.get, { chatId: ours }))?.canManage).toBe(false);
		await expect(member.mutation(api.chats.updateChannel, { chatId: ours, name: "x" })).rejects.toThrow("creator or an owner");
		await owner.mutation(api.chats.updateChannel, { chatId: theirs, name: "Design Team" });
		expect(await member.query(api.chats.get, { chatId: theirs })).toMatchObject({ name: "design-team", topic: "Pixels" });
	});

	it("finds an existing DM instead of making another", async () => {
		const { owner, member } = await ownerAndMember();
		const memberId = await meOf(member);
		const ownerId = await meOf(owner);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [memberId], agentIds: [] });
		expect(await member.mutation(api.chats.openDm, { userIds: [ownerId, memberId], agentIds: [] })).toBe(dm);
		expect((await member.query(api.chats.get, { chatId: dm }))?.title).toBe("owner@co.com");

		const { companybot } = await agentsOf(owner);
		const agentDm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const list = (await owner.query(api.chats.list))!;
		expect(list.me).toBe(ownerId);
		expect(list.dms.find((d) => d._id === agentDm)).toMatchObject({ agentId: companybot._id, title: "Companybot" });
		expect(list.agents.find((a) => a._id === companybot._id)?.dmId).toBe(agentDm);
		expect(list.agents.find((a) => a.name === "Scribe")?.dmId).toBeNull();
		expect(await member.query(api.chats.get, { chatId: agentDm })).toBeNull();
	});

	it("tracks unread and mentions, and clears them on read", async () => {
		const { owner, member } = await ownerAndMember();
		const general = await generalOf(owner);
		await tick();
		await owner.mutation(api.messages.send, { chatId: general._id, text: "hi all", mentions: noMentions });
		expect(await generalOf(member)).toMatchObject({ unread: true, mentioned: false });
		expect(await generalOf(owner)).toMatchObject({ unread: false });
		const memberId = await meOf(member);
		await owner.mutation(api.messages.send, { chatId: general._id, text: "@member look", mentions: { userIds: [memberId], agentIds: [] } });
		expect(await generalOf(member)).toMatchObject({ unread: true, mentioned: true });
		await tick();
		await member.mutation(api.chats.markRead, { chatId: general._id });
		expect(await generalOf(member)).toMatchObject({ unread: false, mentioned: false });
	});

	it("alerts people to unread DMs and mentions, by their notification setting", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.preferences.update, { displayName: "Jaden" });
		const general = await generalOf(owner);
		const memberId = await meOf(member);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [memberId], agentIds: [] });
		await tick();
		await owner.mutation(api.messages.send, { chatId: general._id, text: "hi all", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId: dm, text: "got a sec?", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId: general._id, text: "@member look", mentions: { userIds: [memberId], agentIds: [] } });
		// Plain channel chatter doesn't alert; your own messages never do.
		expect((await member.query(api.chats.alerts))!.map((a) => [a.title, a.text]).sort()).toEqual([
			["Jaden in #general", "@member look"],
			["Jaden", "got a sec?"],
		]);
		expect(await owner.query(api.chats.alerts)).toEqual([]);

		expect((await member.query(api.preferences.get)).notify).toBe("all");
		await member.mutation(api.preferences.update, { notify: "mentions" });
		expect((await member.query(api.chats.alerts))!.map((a) => a.text)).toEqual(["@member look"]);
		await member.mutation(api.preferences.update, { notify: "off" });
		expect(await member.query(api.chats.alerts)).toEqual([]);

		await member.mutation(api.preferences.update, { notify: "all" });
		await tick();
		await member.mutation(api.chats.markRead, { chatId: dm });
		expect((await member.query(api.chats.alerts))!.map((a) => a.text)).toEqual(["@member look"]);
	});

	it("keeps an unread mention, in the dock and the sidebar, however much is said after it", async () => {
		const { t, owner, member } = await ownerAndMember();
		await member.mutation(api.preferences.update, { notify: "mentions" });
		const general = await generalOf(owner);
		const memberId = await meOf(member);
		await tick();
		const mention = await owner.mutation(api.messages.send, {
			chatId: general._id,
			text: "@member look",
			mentions: { userIds: [memberId], agentIds: [] },
		});
		for (let i = 0; i < 60; i++) await owner.mutation(api.messages.send, { chatId: general._id, text: `chatter ${i}`, mentions: noMentions });
		const workspaceId = await t.run(async (ctx) => (await ctx.db.get(general._id))!.workspaceId);
		expect(await member.query(api.chats.alerts)).toEqual([
			{ workspaceId, chatId: general._id, messageId: mention, title: "owner@co.com in #general", text: "@member look" },
		]);
		expect((await generalOf(member)).mentioned).toBe(true);

		// A deleted mention is gone from both.
		await owner.mutation(api.messages.remove, { messageId: mention });
		expect(await member.query(api.chats.alerts)).toEqual([]);
		expect((await generalOf(member)).mentioned).toBe(false);
	});
});

describe("messages", () => {
	it("threads, edits, deletes, and toggles reactions", async () => {
		const { owner, member } = await ownerAndMember();
		const chatId = (await generalOf(owner))._id;
		const parent = await owner.mutation(api.messages.send, { chatId, text: "Plan?", mentions: noMentions });
		await member.mutation(api.messages.send, { chatId, threadId: parent, text: "Yes", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId, threadId: parent, text: "Good", mentions: noMentions });
		const [top] = await owner.query(api.messages.list, { chatId });
		expect(top).toMatchObject({ text: "Plan?", replyCount: 2, mine: true });
		expect(top!.replyAuthors.map((a) => a.name)).toEqual(["owner@co.com", "member@co.com"]);
		expect((await owner.query(api.messages.list, { chatId, threadId: parent })).map((m) => m.text)).toEqual([
			"Plan?",
			"Yes",
			"Good",
		]);

		await owner.mutation(api.messages.react, { messageId: parent, emoji: "👍" });
		await member.mutation(api.messages.react, { messageId: parent, emoji: "👍" });
		let [m] = await member.query(api.messages.list, { chatId });
		expect(m!.reactions).toEqual([{ emoji: "👍", count: 2, mine: true, names: ["owner@co.com", "member@co.com"] }]);
		await member.mutation(api.messages.react, { messageId: parent, emoji: "👍" });
		[m] = await member.query(api.messages.list, { chatId });
		expect(m!.reactions).toEqual([{ emoji: "👍", count: 1, mine: false, names: ["owner@co.com"] }]);

		await expect(member.mutation(api.messages.edit, { messageId: parent, text: "x" })).rejects.toThrow("your own");
		await owner.mutation(api.messages.edit, { messageId: parent, text: "Plan!" });
		expect((await owner.query(api.messages.list, { chatId }))[0]?.editedAt).not.toBeNull();
		await owner.mutation(api.messages.remove, { messageId: parent });
		expect((await owner.query(api.messages.list, { chatId }))[0]).toMatchObject({ deleted: true, text: "", parts: [], replyCount: 2 });
	});
});

describe("agent turns", () => {
	it("replies to mentions in channels, adding the agent to the channel", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "no mention", mentions: noMentions });
		expect(await turnsOf(t)).toHaveLength(0);
		const trigger = await owner.mutation(api.messages.send, {
			chatId,
			text: "@Companybot hi",
			mentions: { userIds: [], agentIds: [companybot._id] },
		});
		const [turn] = await turnsOf(t);
		expect(turn).toMatchObject({ status: "running", triggerId: trigger, agentId: companybot._id });
		expect((await generalOf(owner)).members.some((m) => m.id === companybot._id)).toBe(true);
		const messages = await owner.query(api.messages.list, { chatId });
		expect(messages.at(-1)).toMatchObject({ _id: turn!.replyId, author: { type: "agent", name: "Companybot" }, status: "streaming" });
	});

	it("answers every message in an agent DM, one at a time", async () => {
		const { t, owner } = await ownerAndMember();
		const { scribe } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [scribe._id] });
		await owner.mutation(api.messages.send, { chatId, text: "one", mentions: noMentions });
		await owner.mutation(api.messages.send, { chatId, text: "two", mentions: noMentions });
		let turns = await turnsOf(t);
		expect(turns.map((x) => x.status)).toEqual(["running", "queued"]);

		await t.mutation(internal.turns.finishReply, { turnId: turns[0]!._id, usage: usage(0.01) });
		turns = await turnsOf(t);
		expect(turns.map((x) => x.status)).toEqual(["done", "running"]);
		await t.mutation(internal.turns.finishReply, { turnId: turns[1]!._id, usage: usage(0.02) });
		const stats = (await owner.query(api.messages.list, { chatId })).flatMap((m) => (m.stats ? [m.stats.conversationCostUsd] : []));
		expect(stats).toEqual([0.01, 0.03]);
		expect((await owner.query(api.chats.place, { chatId }))?.costUsd).toBeCloseTo(0.03);
	});

	it("never lets agents trigger agents, and drops mentions of archived agents", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "@Companybot", mentions: { userIds: [], agentIds: [companybot._id] } });
		const [turn] = await turnsOf(t);
		await t.mutation(internal.turns.updateReply, { replyId: turn!.replyId!, text: "@Scribe help", parts: [{ type: "text", text: "@Scribe help" }] });
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });
		expect((await turnsOf(t)).map((x) => x.agentId)).toEqual([companybot._id]);

		await owner.mutation(api.agents.setArchived, { agentId: scribe._id, archived: true });
		await owner.mutation(api.messages.send, { chatId, text: "@Scribe", mentions: { userIds: [], agentIds: [scribe._id] } });
		expect(await turnsOf(t)).toHaveLength(1);
	});

	it("fails a turn stuck over 5 minutes and moves the queue on", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.messages.send, { chatId, text: "one", mentions: noMentions });
		const [stuck] = await turnsOf(t);
		await t.run((ctx) => ctx.db.patch(stuck!._id, { startedAt: Date.now() - 6 * 60_000 }));
		await owner.mutation(api.messages.send, { chatId, text: "two", mentions: noMentions });
		expect((await turnsOf(t)).map((x) => x.status)).toEqual(["error", "running"]);
		const reply = await t.run((ctx) => ctx.db.get(stuck!.replyId!));
		expect(reply).toMatchObject({ status: "error", error: "Reply timed out." });
	});

	it("replies in the thread it was mentioned in", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		const parent = await owner.mutation(api.messages.send, { chatId, text: "Plan", mentions: noMentions });
		await owner.mutation(api.messages.send, {
			chatId,
			threadId: parent,
			text: "@Companybot thoughts?",
			mentions: { userIds: [], agentIds: [companybot._id] },
		});
		const [turn] = await turnsOf(t);
		expect(turn?.threadId).toBe(parent);
		expect((await owner.query(api.messages.list, { chatId, threadId: parent })).map((m) => m.author.type)).toEqual([
			"user",
			"user",
			"agent",
		]);
		const context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.place.thread).toMatchObject({ first: true, parent: { text: "Plan" } });
		expect(context.memory).toBe("team");
	});

	it("feeds new messages since the last reply and replays past turns as sent", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.messages.send, { chatId, text: "first", mentions: noMentions });
		let [turn] = await turnsOf(t);
		let context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		expect(context.memory).toBe("personal");
		expect(context.messages.map((m) => m.text)).toEqual(["first"]);
		await t.mutation(internal.turns.savePrompt, { turnId: turn!._id, prompt: "PROMPT 1" });
		await t.mutation(internal.turns.updateReply, {
			replyId: turn!.replyId!,
			text: "answer",
			parts: [
				{ type: "tool", id: "c1", name: "chat_react", status: "done" },
				{ type: "text", text: "answer" },
			],
		});
		await t.mutation(internal.turns.finishReply, { turnId: turn!._id });

		await owner.mutation(api.messages.send, { chatId, text: "second", mentions: noMentions });
		turn = (await turnsOf(t))[1];
		context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
		// Tools it used replay too, so later it knows it really acted.
		expect(context.session.turns).toEqual([{ prompt: "PROMPT 1", reply: "answer\n[Tools you used: chat_react (done)]" }]);
		expect(context.messages.map((m) => m.text)).toEqual(["second"]);
		expect(context.triggerId).toBe(context.messages[0]!.id);
	});

	it("compacts a session's older turns, keeping a recent tail", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		for (const text of ["a", "b", "c"]) {
			await owner.mutation(api.messages.send, { chatId, text, mentions: noMentions });
			const turn = (await turnsOf(t)).at(-1)!;
			await t.mutation(internal.turns.savePrompt, { turnId: turn._id, prompt: `prompt ${text}`.repeat(10) });
			await t.mutation(internal.turns.finishReply, { turnId: turn._id, usage: usage(0.01) });
		}
		const sessionId = (await turnsOf(t))[0]!.sessionId!;
		const input = await t.mutation(internal.turns.startCompaction, { sessionId, keepTokens: 1 });
		expect(input?.turns).toHaveLength(2);
		expect((await owner.query(api.chats.place, { chatId }))?.compacting).toBe(true);
		expect(await t.mutation(internal.turns.startCompaction, { sessionId })).toBeNull();
		await t.mutation(internal.turns.finishCompaction, { sessionId, result: { summary: "- Said a, b", upTo: input!.upTo, costUsd: 0.005 } });
		const place = await owner.query(api.chats.place, { chatId });
		expect(place).toMatchObject({ summary: "- Said a, b", summarizedUpTo: input!.upTo, compacting: false });
		expect(place?.costUsd).toBeCloseTo(0.035);

		await owner.mutation(api.messages.send, { chatId, text: "d", mentions: noMentions });
		const context = await t.query(internal.turns.turnContext, { turnId: (await turnsOf(t)).at(-1)!._id });
		expect(context.session.summary).toBe("- Said a, b");
		expect(context.session.turns.map((x) => x.prompt.slice(0, 8))).toEqual(["prompt c"]);
	});

	it("lets chat tools see only what the person can, and react to the trigger", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		const chatId = (await generalOf(member))._id;
		const trigger = await member.mutation(api.messages.send, {
			chatId,
			text: "@Companybot what's on #board?",
			mentions: { userIds: [], agentIds: [companybot._id] },
		});
		const [turn] = await turnsOf(t);
		expect(await t.query(internal.turns.readFor, { turnId: turn!._id, chat: "#board" })).toEqual({
			error: 'No channel "#board" you can see.',
		});
		const here = await t.query(internal.turns.readFor, { turnId: turn!._id });
		expect("messages" in here && here.messages.map((m) => [m.chat, m.author, m.text])).toEqual([
			["#general", "member@co.com", "@Companybot what's on #board?"],
		]);
		expect(await t.mutation(internal.turns.reactFor, { turnId: turn!._id, emoji: "👀" })).toEqual({ reacted: true });
		const [m] = (await member.query(api.messages.list, { chatId })).filter((x) => x._id === trigger);
		expect(m!.reactions).toEqual([{ emoji: "👀", count: 1, mine: false, names: ["Companybot"] }]);
		const after = await t.query(internal.turns.readFor, { turnId: turn!._id });
		expect("messages" in after && after.messages[0]?.reactions).toEqual([{ emoji: "👀", by: ["Companybot"] }]);
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

	it("keeps the old plugins.* names working for apps that haven't updated", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.plugins.setInstalled, { pluginId: "notes", installed: true });
		await owner.mutation(api.plugins.setRoles, { pluginId: "notes", roles: ["owner", "member"] });
		await member.action(api.plugins.connect, { pluginId: "notes", credentials: { type: "api_key", key: "k" } });
		expect((await member.query(api.plugins.list)).find((p) => p.id === "notes")).toMatchObject({ installed: true, connected: true });
		await member.mutation(api.plugins.disconnect, { pluginId: "notes" });
		expect((await member.query(api.connectors.list)).find((p) => p.id === "notes")?.connected).toBe(false);
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
		expect(await t.run((ctx) => ctx.db.query("connectorConnections").collect())).toHaveLength(0);
	});
});

describe("automations", () => {
	const tz = "America/Los_Angeles";
	type As = Awaited<ReturnType<typeof signIn>>;
	/** Who wrote each message in this person's DM with the agent, and which automation sent it. */
	const dmWith = async (as: As, agentId: Id<"agents">) => {
		const dmId = (await as.query(api.chats.list))?.agents.find((a) => a._id === agentId)?.dmId;
		const messages = dmId ? await as.query(api.messages.list, { chatId: dmId }) : [];
		return messages.map((m) => [m.author.type, m.automation?.name ?? null]);
	};
	const find = async (as: As, id: string) => (await as.query(api.automations.list)).find((a) => a.id === id);
	/** Runs the scheduler on a Thursday 10am in LA, with every schedule due. */
	async function tickThursday(t: ReturnType<typeof convexTest>) {
		await t.run(async (ctx) => {
			for (const install of await ctx.db.query("automationInstalls").collect()) await ctx.db.patch(install._id, { lastRunDate: "2000-01-01" });
		});
		await t.mutation(internal.automations.tick, { now: Date.UTC(2026, 9, 22, 17) });
	}
	const install = (as: As, automationId: string) => as.mutation(api.automations.setInstalled, { automationId, installed: true, timeZone: tz });

	describe("library", () => {
		it("lets only owners install, needs connectors first, and turns it on for the installer only", async () => {
			const { owner, member } = await ownerAndMember();
			await expect(install(member, "morning-brief")).rejects.toThrow("permission");
			await expect(install(owner, "crm-digest")).rejects.toThrow("Install the CRM connector first");
			await install(owner, "morning-brief");
			const brief = (await find(member, "morning-brief"))!;
			expect([brief.installed, brief.audience, brief.subscribed, brief.subscriberCount, brief.trigger]).toEqual([
				true,
				"subscribers",
				false,
				1,
				"Weekdays at 8:00 AM",
			]);
			expect((await find(owner, "morning-brief"))!.subscribed).toBe(true);
		});

		it("runs a schedule only for people who turned it on", async () => {
			const { t, owner, member } = await ownerAndMember();
			await install(owner, "morning-brief");
			await tickThursday(t);
			const { companybot } = await agentsOf(member);
			expect(await dmWith(member, companybot._id)).toHaveLength(0);
			expect(await dmWith(owner, companybot._id)).toEqual([
				["user", "Morning brief"],
				["agent", null],
			]);

			await member.mutation(api.automations.subscribe, { automationId: "morning-brief", on: true });
			await tickThursday(t);
			expect(await dmWith(member, companybot._id)).toHaveLength(2);
			expect((await find(owner, "morning-brief"))!.lastResult).toBe("Sent to 2 people.");
			await member.mutation(api.automations.subscribe, { automationId: "morning-brief", on: false });
			expect((await find(member, "morning-brief"))!.subscribed).toBe(false);
		});

		it("posts once in a channel when an owner picks one; members can't change it", async () => {
			const { t, owner, member } = await ownerAndMember();
			await install(owner, "morning-brief");
			const sales = await owner.mutation(api.chats.createChannel, { name: "sales", private: false });
			const toSales = { automationId: "morning-brief", audience: "channel" as const, channelId: sales };
			await expect(member.mutation(api.automations.update, toSales)).rejects.toThrow("permission");
			await owner.mutation(api.automations.update, toSales);
			await expect(member.mutation(api.automations.subscribe, { automationId: "morning-brief", on: true })).rejects.toThrow(
				"isn't one people turn on",
			);
			await tickThursday(t);
			const messages = await member.query(api.messages.list, { chatId: sales });
			expect(messages.map((m) => [m.author.type, m.author.name, m.automation?.name ?? null])).toEqual([
				["user", "owner@co.com", "Morning brief"],
				["agent", "Companybot", null],
			]);
			const brief = (await find(owner, "morning-brief"))!;
			expect([brief.lastResult, brief.runsFor]).toEqual(["Posted in #sales.", "Posts once in #sales"]);
		});

		it("still takes what apps from before audiences send: a channel, or null for DMs", async () => {
			const { owner } = await ownerAndMember();
			await install(owner, "morning-brief");
			const sales = await owner.mutation(api.chats.createChannel, { name: "sales", private: false });
			await owner.mutation(api.automations.update, { automationId: "morning-brief", channelId: sales });
			expect((await find(owner, "morning-brief"))!.audience).toBe("channel");
			await owner.mutation(api.automations.update, { automationId: "morning-brief", channelId: null });
			expect((await find(owner, "morning-brief"))!.audience).toBe("subscribers");
		});

		it("runs now just for the person who clicked, if they can change it", async () => {
			const { owner, member } = await ownerAndMember();
			await install(owner, "morning-brief");
			await owner.mutation(api.automations.update, { automationId: "morning-brief", enabled: false });
			await owner.mutation(api.automations.runNow, { automationId: "morning-brief" });
			const { companybot } = await agentsOf(owner);
			expect(await dmWith(owner, companybot._id)).toHaveLength(2);
			await expect(member.mutation(api.automations.runNow, { automationId: "morning-brief" })).rejects.toThrow("permission");
		});
	});

	describe("webhooks", () => {
		const call = (id: string, extra: object = {}) =>
			JSON.stringify({ event: "call.ended", id, data: { summary: "Leaky water heater." }, ...extra });

		async function installed() {
			const ctx = await ownerAndMember();
			await install(ctx.owner, "after-call-summary");
			const url = (await find(ctx.owner, "after-call-summary"))!.webhookUrl!;
			const post = async (body: string, path = new URL(url, "http://x").pathname) => {
				const res = await ctx.t.fetch(path, { method: "POST", body });
				return [res.status, ((await res.json()) as { message: string }).message] as const;
			};
			return { ...ctx, url, post };
		}

		it("shows the secret URL only to people who can change it, and resets it", async () => {
			const { owner, member, url, post } = await installed();
			expect(url).toMatch(/\/automations\/[0-9a-f]{48}$/);
			expect((await find(member, "after-call-summary"))!.webhookUrl).toBeNull();
			await expect(member.mutation(api.automations.resetWebhook, { automationId: "after-call-summary" })).rejects.toThrow(
				"permission",
			);
			await owner.mutation(api.automations.resetWebhook, { automationId: "after-call-summary" });
			expect((await find(owner, "after-call-summary"))!.webhookUrl).not.toBe(url);
			expect(await post(call("1"))).toEqual([404, "Unknown webhook URL."]);
		});

		it("runs for the person named only if they turned it on, once per event id, with its data", async () => {
			const { member, post } = await installed();
			const named = { person: { email: "MEMBER@co.com" } };
			expect(await post(call("c1", named))).toEqual([200, "Didn't run: the person it's for hasn't turned it on."]);
			await member.mutation(api.automations.subscribe, { automationId: "after-call-summary", on: true });
			expect(await post(call("c2", named))).toEqual([200, "Sent to 1 person."]);
			expect(await post(call("c2", named))).toEqual([200, "Already received."]);
			const { companybot } = await agentsOf(member);
			expect(await dmWith(member, companybot._id)).toEqual([
				["user", "After-call summary"],
				["agent", null],
			]);
			const dmId = (await member.query(api.chats.list))!.agents.find((a) => a._id === companybot._id)!.dmId!;
			expect((await member.query(api.messages.list, { chatId: dmId }))[0]!.text).toContain("Leaky water heater.");
			expect(await post(call("c3", { person: { email: "nobody@co.com" } }))).toEqual([
				200,
				"Didn't run: nobody here has the email nobody@co.com.",
			]);
			// Naming nobody: everyone who turned it on.
			expect(await post(call("c4"))).toEqual([200, "Sent to 2 people."]);
		});

		it("posts in the channel when one is picked", async () => {
			const { owner, member, post } = await installed();
			const calls = await owner.mutation(api.chats.createChannel, { name: "calls", private: false });
			await owner.mutation(api.automations.update, { automationId: "after-call-summary", audience: "channel", channelId: calls });
			expect(await post(call("c1"))).toEqual([200, "Posted in #calls."]);
			expect(await member.query(api.messages.list, { chatId: calls })).toHaveLength(2);
		});

		it("forgets event ids after a week, and when uninstalled", async () => {
			const { t, owner, post } = await installed();
			await post(call("old"));
			const events = () => t.run((ctx) => ctx.db.query("automationEvents").collect());
			vi.useFakeTimers({ now: Date.now() + 8 * 24 * 60 * 60 * 1000, toFake: ["Date"] });
			try {
				await post(call("new"));
				await t.mutation(internal.automations.forgetOldWebhooks);
			} finally {
				vi.useRealTimers();
			}
			expect((await events()).map((e) => e.eventId)).toEqual(["new"]);
			await owner.mutation(api.automations.setInstalled, { automationId: "after-call-summary", installed: false, timeZone: tz });
			expect(await events()).toHaveLength(0);
		});

		it("refuses bad bodies and skips when turned off", async () => {
			const { owner, post } = await installed();
			expect(await post("nope")).toEqual([400, "Body isn't JSON."]);
			expect(await post(JSON.stringify({ event: "call.started", id: "1" }))).toEqual([400, "This URL takes call.ended events."]);
			expect(await post(JSON.stringify({ event: "call.ended" }))).toEqual([400, "id must be a string of 1-200 characters."]);
			expect(await post(call("1"), "/automations/wrong")).toEqual([404, "Unknown webhook URL."]);
			expect(await post(call("1".repeat(40_000)))).toEqual([413, "Body is over 32 KB."]);
			await owner.mutation(api.automations.update, { automationId: "after-call-summary", enabled: false });
			expect(await post(call("1"))).toEqual([200, "Not run: the automation is off."]);
		});
	});

	describe("made by anyone", () => {
		const daily = { type: "schedule" as const, time: "09:00", weekdays: [5, 1, 2, 3, 4] };
		async function make(as: As, config: { name: string; prompt: string; trigger: unknown }, audience: "creator" | "subscribers" | "channel" = "creator", channelId?: Id<"chats">) {
			const { companybot } = await agentsOf(as);
			return as.mutation(api.automations.create, {
				config: config as never,
				agentId: companybot._id,
				audience,
				channelId,
				timeZone: tz,
			});
		}

		it("lets members make their own, private to them, and checks what they wrote", async () => {
			const { t, owner, member } = await ownerAndMember();
			const id = await make(member, { name: "Standup", prompt: "Ask what I'm on today.", trigger: daily });
			expect(await find(owner, id)).toBeUndefined();
			const mine = (await find(member, id))!;
			expect(mine).toMatchObject({ name: "Standup", publisher: "Your team", trigger: "Weekdays at 9:00 AM", audience: "creator", canEdit: true });
			expect(mine.custom).toMatchObject({ version: 1, trigger: { weekdays: [1, 2, 3, 4, 5] } });
			await expect(make(member, { name: " ", prompt: "y", trigger: daily })).rejects.toThrow("Give it a name.");
			await expect(make(member, { name: "x", prompt: "", trigger: daily })).rejects.toThrow("Say what the agent should do.");
			await expect(make(member, { name: "x", prompt: "y", trigger: { ...daily, time: "25:00" } })).rejects.toThrow("Pick a time.");
			await expect(make(member, { name: "x", prompt: "y", trigger: { ...daily, weekdays: [] } })).rejects.toThrow("Pick at least one day.");

			await tickThursday(t);
			const { companybot } = await agentsOf(member);
			expect(await dmWith(member, companybot._id)).toEqual([
				["user", "Standup"],
				["agent", null],
			]);
			expect(await dmWith(owner, companybot._id)).toHaveLength(0);
		});

		it("lets an owner rename one watching a channel they're not in, but not make it just for them", async () => {
			const { t, owner, member } = await ownerAndMember();
			const ops = await member.mutation(api.chats.createChannel, { name: "ops", private: true });
			const { companybot } = await agentsOf(member);
			const config = { name: "Ops log", prompt: "Log it.", trigger: { type: "event" as const, event: "message.posted" as const, channelId: ops } };
			const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: tz });
			await owner.mutation(api.automations.save, { automationId: id, config: { ...config, name: "Ops diary" }, expectedVersion: 1 });
			await expect(owner.mutation(api.automations.update, { automationId: id, audience: "creator" })).rejects.toThrow(
				"Only the person who made it can make it just for them.",
			);
			// Turning it into a schedule after today's time starts tomorrow, not on the next tick.
			const schedule = { type: "schedule" as const, time: "00:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };
			await member.mutation(api.automations.save, { automationId: id, config: { ...config, trigger: schedule }, expectedVersion: 2 });
			await t.mutation(internal.automations.tick, {});
			expect((await find(member, id))!.lastRunAt).toBeNull();
		});

		it("lets the creator or an owner change it, nobody else", async () => {
			const { t, owner, member } = await ownerAndMember();
			await owner.mutation(api.workspace.invite, { email: "other@co.com", role: "member" });
			const other = await signIn(t, "other@co.com");
			const id = await make(member, { name: "Leads", prompt: "Post the lead.", trigger: daily }, "subscribers");
			const config = { name: "  New leads  ", prompt: "  Post the lead.  ", trigger: { type: "webhook" as const } };
			await expect(other.mutation(api.automations.save, { automationId: id, config, expectedVersion: 1 })).rejects.toThrow("Only the person who made");
			expect((await find(other, id))!.canEdit).toBe(false);
			await owner.mutation(api.automations.save, { automationId: id, config, expectedVersion: 1 });
			await expect(member.mutation(api.automations.save, { automationId: id, config: { ...config, name: "" }, expectedVersion: 1 })).rejects.toThrow("Someone else saved a change");
			await expect(member.mutation(api.automations.save, { automationId: id, config: { ...config, name: "" }, expectedVersion: 2 })).rejects.toThrow("Give it a name.");
			const saved = (await find(member, id))!;
			expect([saved.name, saved.trigger, saved.custom!.version]).toEqual(["New leads", "When another app sends a webhook", 2]);
			expect(saved.custom).toMatchObject({ prompt: "Post the lead.", updatedByName: "owner@co.com", updatedAt: expect.any(Number) });
			expect(saved.createdByName).toBe("member@co.com");
			expect(saved.webhookUrl).toMatch(/\/automations\/[0-9a-f]{48}$/);
			await member.mutation(api.automations.save, { automationId: id, config: { ...config, trigger: daily }, expectedVersion: 2 });
			expect((await find(member, id))!.webhookUrl).toBeNull();
			await expect(other.mutation(api.automations.setInstalled, { automationId: id, installed: false, timeZone: tz })).rejects.toThrow(
				"Only the person who made",
			);
			await member.mutation(api.automations.setInstalled, { automationId: id, installed: false, timeZone: tz });
			expect(await find(member, id)).toBeUndefined();
		});

		it.each([false, true])("removes custom automations and related rows (legacy: %s)", async (legacy) => {
			const { t, owner, member } = await ownerAndMember();
			await owner.mutation(api.workspace.invite, { email: "other@co.com", role: "member" });
			const other = await signIn(t, "other@co.com");
			const id = await make(member, { name: "Forms", prompt: "Post it.", trigger: { type: "webhook" } }, "subscribers");
			const path = new URL((await find(member, id))!.webhookUrl!, "http://x").pathname;
			await t.fetch(path, { method: "POST", body: JSON.stringify({ id: "delivery-1" }) });
			await other.mutation(api.automations.subscribe, { automationId: id, on: true });
			const remove = (as: typeof owner) => legacy
				? as.mutation(api.automations.setInstalled, { automationId: id, installed: false })
				: as.mutation(api.automations.remove, { automationId: id });
			await expect(remove(other)).rejects.toThrow("Only the person who made");
			expect(await find(member, id)).toBeDefined();
			await remove(member);
			await remove(member);
			expect(await find(member, id)).toBeUndefined();
			const rows = await t.run(async (ctx) => ({
				installs: await ctx.db.query("automationInstalls").collect(),
				subscriptions: await ctx.db.query("automationSubscriptions").collect(),
				deliveries: await ctx.db.query("automationEvents").collect(),
			}));
			expect(rows).toEqual({ installs: [], subscriptions: [], deliveries: [] });
			expect((await t.fetch(path, { method: "POST", body: JSON.stringify({ id: "delivery-2" }) })).status).toBe(404);
			const shared = await make(member, { name: "Shared", prompt: "Ask.", trigger: daily }, "subscribers");
			await owner.mutation(api.automations.remove, { automationId: shared });
			expect(await find(member, shared)).toBeUndefined();
		});

		it("only lets owners uninstall library automations, without a time zone", async () => {
			const { t, owner, member } = await ownerAndMember();
			await install(owner, "morning-brief");
			await expect(member.mutation(api.automations.remove, { automationId: "morning-brief" })).rejects.toThrow("permission");
			await owner.mutation(api.automations.remove, { automationId: "morning-brief" });
			await owner.mutation(api.automations.remove, { automationId: "morning-brief" });
			expect((await find(owner, "morning-brief"))!.installed).toBe(false);
			expect(await t.run((ctx) => ctx.db.query("automationSubscriptions").collect())).toHaveLength(0);
			await install(owner, "morning-brief");
			await owner.mutation(api.automations.setInstalled, { automationId: "morning-brief", installed: false });
			expect((await find(owner, "morning-brief"))!.installed).toBe(false);
			await expect(owner.mutation(api.automations.setInstalled, { automationId: "morning-brief", installed: true })).rejects.toThrow("Unknown time zone.");
		});

		it("takes any webhook body when it has no named event", async () => {
			const { t, owner } = await ownerAndMember();
			const sales = await owner.mutation(api.chats.createChannel, { name: "sales", private: false });
			const id = await make(owner, { name: "Forms", prompt: "Post the form.", trigger: { type: "webhook" } }, "channel", sales);
			const path = new URL((await find(owner, id))!.webhookUrl!, "http://x").pathname;
			const post = async (body: object) => (await t.fetch(path, { method: "POST", body: JSON.stringify(body) })).status;
			expect(await post({ id: "f1", data: { email: "a@b.com" } })).toBe(200);
			expect(await post({ event: "form.submitted", id: "f2" })).toBe(200);
			const posted = (await owner.query(api.messages.list, { chatId: sales })).filter((m) => m.automation);
			expect(posted.map((m) => m.automation!.name)).toEqual(["Forms", "Forms"]);
		});
	});

	describe("from chat", () => {
		it("lets an agent set one up for the person it's helping, with their rules", async () => {
			const { t, owner, member } = await ownerAndMember();
			const { companybot } = await agentsOf(owner);
			await owner.mutation(api.chats.createChannel, { name: "board", private: true });
			await member.mutation(api.messages.send, {
				chatId: (await generalOf(member))._id,
				text: "@Companybot every Monday send me quiet deals",
				mentions: { userIds: [], agentIds: [companybot._id] },
			});
			const turnId = (await turnsOf(t))[0]!._id;
			const create = (input: object) => t.mutation(internal.automations.createFor, { turnId, input });
			const weekly = { name: "Quiet deals", prompt: "List deals with no activity in 2 weeks.", trigger: { type: "schedule", time: "09:00", days: ["mon"] } };

			const made = await create({ ...weekly, runsFor: "me" });
			expect(made).toMatchObject({ name: "Quiet deals", when: "Mon at 9:00 AM (UTC)", runsFor: "Just member@co.com, in their chat with the agent" });
			const listed = await t.query(internal.automations.listFor, { turnId });
			expect(listed).toEqual([expect.objectContaining({ name: "Quiet deals", madeByYou: true, onForYou: null })]);
			expect(await create({ ...weekly, runsFor: "#board" })).toEqual({ error: "There's no channel #board they can see." });
			expect(await create({ ...weekly, runsFor: "everyone" })).toEqual({ error: 'runsFor must be "me", "anyone", or a channel like "#sales".' });
			expect(await create({ ...weekly, name: "" })).toEqual({ error: "Give it a name." });
			const hook = await create({ name: "Forms", prompt: "Post it.", trigger: { type: "webhook" }, runsFor: "me" });
			expect(hook).toMatchObject({ webhookUrl: expect.stringMatching(/\/automations\/[0-9a-f]{48}$/) });

			await install(owner, "morning-brief");
			expect(await t.mutation(internal.automations.setMineFor, { turnId, id: "morning-brief", on: true })).toEqual({ id: "morning-brief", on: true });
			expect((await find(member, "morning-brief"))!.subscribed).toBe(true);
		});
	});

	describe("in-app events", () => {
		it("replies in the thread of a message posted in the channel it watches", async () => {
			const { owner, member } = await ownerAndMember();
			const support = await owner.mutation(api.chats.createChannel, { name: "support", private: false });
			const other = await owner.mutation(api.chats.createChannel, { name: "random", private: false });
			const { companybot } = await agentsOf(owner);
			await owner.mutation(api.automations.create, {
				config: { name: "Triage", prompt: "Tag the request.", trigger: { type: "event", event: "message.posted", channelId: support } },
				agentId: companybot._id,
				audience: "channel",
				channelId: support,
				timeZone: tz,
			});
			expect((await find(owner, (await owner.query(api.automations.list))[0]!.id))!.trigger).toBe("When someone posts in #support");
			const send = (chatId: Id<"chats">, text: string) =>
				member.mutation(api.messages.send, { chatId, text, mentions: { userIds: [], agentIds: [] } });
			await send(other, "unrelated");
			const messageId = await send(support, "My invoice is wrong");
			const top = await member.query(api.messages.list, { chatId: support });
			expect(top.map((m) => m.text)).toEqual(["My invoice is wrong"]);
			const [, ...replies] = await member.query(api.messages.list, { chatId: support, threadId: messageId });
			expect(replies.map((m) => [m.author.type, m.automation?.name ?? null])).toEqual([
				["user", "Triage"],
				["agent", null],
			]);
			expect(replies[0]!.text).toContain("My invoice is wrong");
		});

		it("posts what a private channel says only back into that channel", async () => {
			const { owner } = await ownerAndMember();
			const board = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
			const general = (await generalOf(owner))._id;
			const { companybot } = await agentsOf(owner);
			const watchBoard = { name: "Relay", prompt: "Repeat it.", trigger: { type: "event" as const, event: "message.posted" as const, channelId: board } };
			const base = { config: watchBoard, agentId: companybot._id, timeZone: tz };
			await expect(owner.mutation(api.automations.create, { ...base, audience: "channel", channelId: general })).rejects.toThrow(
				"which is private, so it can only post there",
			);
			const id = await owner.mutation(api.automations.create, { ...base, audience: "subscribers" });
			await expect(owner.mutation(api.automations.update, { automationId: id, audience: "channel", channelId: general })).rejects.toThrow(
				"which is private",
			);
			await owner.mutation(api.automations.update, { automationId: id, audience: "channel", channelId: board });
		});

		it("runs ones people make only as their maker, never falling back to an owner", async () => {
			const { t, owner, member } = await ownerAndMember();
			const ops = await member.mutation(api.chats.createChannel, { name: "ops", private: true });
			await member.mutation(api.chats.addMembers, { chatId: ops, userIds: [await meOf(owner)], agentIds: [] });
			const { companybot } = await agentsOf(member);
			const id = await member.mutation(api.automations.create, {
				config: { name: "Hook", prompt: "Act on it.", trigger: { type: "webhook" } },
				agentId: companybot._id,
				audience: "channel",
				channelId: ops,
				timeZone: tz,
			});
			const token = (await find(member, id))!.webhookUrl!.split("/").at(-1)!;
			await member.mutation(api.chats.leave, { chatId: ops });
			await t.mutation(internal.automations.receive, { token, body: JSON.stringify({ id: "e1", data: {} }) });
			expect((await find(member, id))!.lastResult).toBe("Didn't run: member@co.com, who made it, isn't in #ops. Pick another channel.");
			expect((await owner.query(api.messages.list, { chatId: ops })).some((m) => m.automation)).toBe(false);
		});

		it("gives people only events from chats they can see", async () => {
			const { owner, member } = await ownerAndMember();
			const board = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
			const { companybot } = await agentsOf(member);
			await expect(
				member.mutation(api.automations.create, {
					config: { name: "Spy", prompt: "x", trigger: { type: "event", event: "message.posted", channelId: board } },
					agentId: companybot._id,
					audience: "creator",
					timeZone: tz,
				}),
			).rejects.toThrow("That channel isn't available.");
			await owner.mutation(api.automations.create, {
				config: { name: "Board notes", prompt: "Note it.", trigger: { type: "event", event: "message.posted", channelId: board } },
				agentId: companybot._id,
				audience: "subscribers",
				timeZone: tz,
			});
			const id = (await owner.query(api.automations.list))[0]!.id;
			await member.mutation(api.automations.subscribe, { automationId: id, on: true });
			await owner.mutation(api.messages.send, { chatId: board, text: "Raise prices", mentions: { userIds: [], agentIds: [] } });
			expect(await dmWith(member, companybot._id)).toHaveLength(0);
			expect(await dmWith(owner, companybot._id)).toEqual([
				["user", "Board notes"],
				["agent", null],
			]);
		});

		it("runs when someone joins the workspace", async () => {
			const { t, owner } = await ownerAndMember();
			const { companybot } = await agentsOf(owner);
			await owner.mutation(api.automations.create, {
				config: { name: "Welcome", prompt: "Welcome them.", trigger: { type: "event", event: "member.joined" } },
				agentId: companybot._id,
				audience: "creator",
				timeZone: tz,
			});
			await owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
			await signIn(t, "new@co.com");
			expect(await dmWith(owner, companybot._id)).toEqual([
				["user", "Welcome"],
				["agent", null],
			]);
		});
	});
});

describe("activity log", () => {
	const mention = (agentId: Id<"agents">) => ({ userIds: [], agentIds: [agentId] });
	const call = { callId: "c1", tool: "memory.remember_for_team", changes: true, input: '{"content":"x"}', output: '{"id":"m1"}' };

	it("shows calls to whoever can see the chat, and results only to the person", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "@Companybot remember x", mentions: mention(companybot._id) });
		const [turn] = await turnsOf(t);
		await t.mutation(internal.activity.log, { turnId: turn!._id, ...call });

		expect(await owner.query(api.activity.list, {})).toMatchObject([
			{ agent: "Companybot", tool: call.tool, chat: "#general", mine: true, output: call.output, status: "done" },
		]);
		const [theirs] = await member.query(api.activity.list, {});
		expect(theirs).toMatchObject({ mine: false, input: call.input, actor: "owner@co.com" });
		expect(theirs!.output).toBeUndefined();
		expect(await member.query(api.activity.forReply, { replyId: turn!.replyId! })).toHaveLength(1);
	});

	it("hides calls from chats the person can't see", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		await owner.mutation(api.messages.send, { chatId, text: "@Companybot hi", mentions: mention(companybot._id) });
		const [turn] = await turnsOf(t);
		await t.mutation(internal.activity.log, { turnId: turn!._id, ...call, output: undefined, error: "Nope" });

		expect(await owner.query(api.activity.list, {})).toMatchObject([{ status: "error", error: "Nope", chat: "#board" }]);
		expect(await member.query(api.activity.list, {})).toEqual([]);
		expect(await member.query(api.activity.forReply, { replyId: turn!.replyId! })).toEqual([]);
	});

	it("marks memories an agent changed until a person edits them", async () => {
		const { t, owner } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
		const made = await t.mutation(internal.memory.createFor, { turnId: await agentTurn(t, owner, dm, agentId), scope: "personal", content: "Likes tea." });
		expect((await owner.query(api.memory.list))[0]).toMatchObject({ updatedByAgent: true });
		await owner.mutation(api.memory.update, { id: made.id as Id<"memories">, content: "Likes coffee.", expectedVersion: 1 });
		expect((await owner.query(api.memory.list))[0]!.updatedByAgent).toBeUndefined();
	});
});

describe("time zones", () => {
	it("defaults to the computer's zone, lets people pick one, and tells agents", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const timeZoneOfOwner = async () => (await owner.query(api.workspace.team))!.members.find((m) => m.isYou)!.timeZone;
		expect(await timeZoneOfOwner()).toBe("UTC");

		await owner.mutation(api.preferences.update, { deviceTimeZone: "Europe/Paris" });
		expect(await owner.query(api.preferences.get)).toMatchObject({ timeZone: null, deviceTimeZone: "Europe/Paris" });
		expect(await timeZoneOfOwner()).toBe("Europe/Paris");

		await owner.mutation(api.preferences.update, { timeZone: "America/Los_Angeles" });
		expect(await timeZoneOfOwner()).toBe("America/Los_Angeles");
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.messages.send, { chatId, text: "What time is it?", mentions: noMentions });
		const [turn] = await turnsOf(t);
		expect((await t.query(internal.turns.turnContext, { turnId: turn!._id })).actor.timeZone).toBe("America/Los_Angeles");

		await owner.mutation(api.preferences.update, { timeZone: null });
		expect(await timeZoneOfOwner()).toBe("Europe/Paris");
		await expect(owner.mutation(api.preferences.update, { timeZone: "Mars/Base" })).rejects.toThrow("Unknown time zone");
	});

});

describe("migrations", () => {
	it("indexes mentions in messages sent before the mentions index", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		const general = await generalOf(owner);
		const messageId = await t.run(async (ctx) => {
			const { userId, workspaceId } = (await ctx.db.query("members").first())!;
			const message = { chatId: general._id, workspaceId, text: "@you", parts: [], status: "done" as const };
			await ctx.db.insert("chatMessages", { ...message, threadId: undefined, mentions: { userIds: [], agentIds: [] } });
			return ctx.db.insert("chatMessages", { ...message, mentions: { userIds: [userId, userId], agentIds: [] } });
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const rows = await t.run((ctx) => ctx.db.query("userMentions").collect());
		expect(rows.map((r) => r.messageId)).toEqual([messageId]);
	});

	it("moves rows from the old plugin tables to the connector tables", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		const owner = await signIn(t, "owner@co.com");
		await t.run(async (ctx) => {
			const { userId, workspaceId } = (await ctx.db.query("members").first())!;
			await ctx.db.insert("pluginInstalls", { workspaceId, pluginId: "crm", roles: ["owner"], installedBy: userId });
			await ctx.db.insert("pluginConnections", { workspaceId, pluginId: "crm", userId: null, credentials: "enc", connectedBy: userId });
			await ctx.db.insert("pluginOAuthFlows", { state: "s", pluginId: "crm", userId, data: "d", expiresAt: 1 });
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const rows = await t.run(async (ctx) => ({
			old: [
				...(await ctx.db.query("pluginInstalls").collect()),
				...(await ctx.db.query("pluginConnections").collect()),
				...(await ctx.db.query("pluginOAuthFlows").collect()),
			].length,
			installs: await ctx.db.query("connectorInstalls").collect(),
			connections: await ctx.db.query("connectorConnections").collect(),
			flows: await ctx.db.query("connectorOAuthFlows").collect(),
		}));
		expect(rows.old).toBe(0);
		expect(rows.installs.map((r) => [r.connectorId, r.roles])).toEqual([["crm", ["owner"]]]);
		expect(rows.connections.map((r) => [r.connectorId, r.credentials])).toEqual([["crm", "enc"]]);
		expect(rows.flows.map((r) => [r.connectorId, r.state])).toEqual([["crm", "s"]]);
		expect(await owner.query(api.connectors.list)).toContainEqual(expect.objectContaining({ id: "crm", installed: true }));
	});

	it("gives old automation installs an audience, keeping channels and subscribing the installer", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const ids = await t.run(async (ctx) => {
			const { userId, workspaceId } = (await ctx.db.query("members").first())!;
			const agentId = (await ctx.db.query("agents").first())!._id;
			const channelId = (await ctx.db.query("chats").first())!._id;
			const base = { workspaceId, agentId, enabled: true, timeZone: "UTC", installedBy: userId };
			return {
				userId,
				dms: await ctx.db.insert("automationInstalls", { ...base, automationId: "morning-brief" }),
				channel: await ctx.db.insert("automationInstalls", { ...base, automationId: "after-call-summary", channelId }),
			};
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const after = await t.run(async (ctx) => ({
			dms: (await ctx.db.get(ids.dms))!.audience,
			channel: (await ctx.db.get(ids.channel))!.audience,
			subs: (await ctx.db.query("automationSubscriptions").collect()).map((s) => [s.installId, s.userId]),
		}));
		expect(after).toEqual({ dms: "subscribers", channel: "channel", subs: [[ids.dms, ids.userId]] });
	});
});

describe("migrations: Companybot chat tools", () => {
	it("adds the make-skills, automations and records tools to existing Companybots, each as a new version", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		migrationsTest.register(t);
		await signIn(t, "owner@co.com");
		const ids = await t.run(async (ctx) => {
			const agents = await ctx.db.query("agents").collect();
			const bot = agents.find((a) => a.name === "Companybot")!;
			const scribe = agents.find((a) => a.name === "Scribe")!;
			await ctx.db.patch(bot._id, { tools: ["memory.*", "skills.load", "chat.*"] });
			return { bot: bot._id, scribe: scribe._id, version: bot.version };
		});
		vi.useFakeTimers();
		try {
			await t.mutation(internal.migrations.runAll);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
		} finally {
			vi.useRealTimers();
		}
		const after = await t.run(async (ctx) => ({ bot: (await ctx.db.get(ids.bot))!, scribe: (await ctx.db.get(ids.scribe))! }));
		expect(after.bot.tools).toEqual(["memory.*", "skills.load", "chat.*", "skills.create", "automations.*", "records.*"]);
		expect(after.bot.version).toBe(ids.version + 2);
		expect(after.scribe.tools).not.toContain("skills.create");
		expect(after.scribe.tools).not.toContain("records.*");
	});
});

describe("approvals", () => {
	const call = { tool: "crm.send_sms", input: { to: "+15550100", body: "See you at 3" } };

	/** The member asks Companybot in `chatId`; the reply holds `call` for approval. Returns the asking turn and approval. */
	async function holdCall(t: ReturnType<typeof convexTest>, as: As, chatId: Id<"chats">, finish = true) {
		const { companybot } = await agentsOf(as);
		await as.mutation(api.messages.send, { chatId, text: "@Companybot text Bob", mentions: { userIds: [], agentIds: [companybot._id] } });
		// The test plays the runner, so the real one (a model call) must not race it.
		await t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
		});
		const turn = (await turnsOf(t)).at(-1)!;
		// What the runner stores before calling the model; set here so no model call is needed.
		await t.mutation(internal.turns.savePrompt, { turnId: turn._id, prompt: "Reply to this message: text Bob" });
		const approvalId = await t.mutation(internal.approvals.request, {
			turnId: turn._id,
			callId: "c1",
			tool: call.tool,
			input: canonicalJson(call.input),
		});
		const parts = [{ type: "approval" as const, id: "c1", approvalId, tool: call.tool }];
		await t.mutation(internal.turns.updateReply, { replyId: turn.replyId!, text: "", parts });
		if (finish) await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		const [card] = await as.query(api.approvals.forReply, { replyId: turn.replyId! });
		return { turn, approvalId, card: card! };
	}

	it("shows the exact call to the chat, and lets only the person the agent acts for decide", async () => {
		const { t, owner, member } = await ownerAndMember();
		const chatId = (await generalOf(owner))._id;
		const { turn, approvalId, card } = await holdCall(t, member, chatId);
		expect(card).toMatchObject({
			service: "CRM",
			action: "Send SMS",
			input: canonicalJson(call.input),
			status: "pending",
			approver: "member@co.com",
			canDecide: true,
		});
		expect(card.hash).toBe(await approvalHash(call.tool, call.input));
		const [theirs] = await owner.query(api.approvals.forReply, { replyId: turn.replyId! });
		expect(theirs).toMatchObject({ canDecide: false, input: card.input });

		// Apps from before approvals can't draw the card, so they get a line of text instead.
		const reply = (await owner.query(api.messages.list, { chatId })).find((m) => m._id === turn.replyId)!;
		expect(reply.parts).toEqual([{ type: "text", text: expect.stringContaining("Waiting for approval to run crm.send_sms") }]);
		expect(reply.fullParts).toMatchObject([{ type: "approval", tool: call.tool }]);

		// Owners can't approve for someone else: the call would run as them.
		await expect(owner.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true })).rejects.toThrow(
			"Only member@co.com can decide this",
		);
		expect((await member.query(api.approvals.forReply, { replyId: turn.replyId! }))[0]?.status).toBe("pending");
	});

	it("refuses a hash other than the stored call's, and decided or expired requests", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { approvalId, card } = await holdCall(t, member, chatId);
		const otherHash = await approvalHash(call.tool, { ...call.input, body: "See you at 4" });
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: otherHash, approve: true })).rejects.toThrow(
			"isn't the one you were shown",
		);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: false });
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true })).rejects.toThrow("already decided");
		await t.mutation(internal.turns.finishReply, { turnId: (await turnsOf(t)).at(-1)!._id });

		const second = await holdCall(t, member, chatId);
		vi.useFakeTimers({ now: Date.now() + APPROVAL_TTL_MS + 1, toFake: ["Date"] });
		try {
			expect(second.card.status).toBe("pending");
			const [now] = await member.query(api.approvals.forReply, { replyId: second.turn.replyId! });
			expect(now?.status).toBe("expired");
			await expect(
				member.mutation(api.approvals.decide, { approvalId: second.approvalId, hash: second.card.hash, approve: true }),
			).rejects.toThrow("expired");
		} finally {
			vi.useRealTimers();
		}
	});

	it("can't be decided once the person can't see the chat", async () => {
		const { t, owner, member } = await ownerAndMember();
		const chatId = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		await owner.mutation(api.chats.addMembers, { chatId, userIds: [await meOf(member)], agentIds: [] });
		const { approvalId, card } = await holdCall(t, member, chatId);
		await member.mutation(api.chats.leave, { chatId });
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true })).rejects.toThrow("not found");
	});

	it("queues an approved call behind the running turn, then runs exactly what was approved, once", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { turn, approvalId, card } = await holdCall(t, member, chatId, false);

		// Decided while the asking reply is still running: it waits its turn in the place.
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true });
		expect((await turnsOf(t)).map((x) => x.status)).toEqual(["running", "queued"]);
		await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		const next = (await turnsOf(t))[1]!;
		expect(next).toMatchObject({ status: "running", approvalId, triggerId: turn.triggerId });

		const context = await t.query(internal.turns.turnContext, { turnId: next._id });
		expect(context.approval).toMatchObject({ id: approvalId, tool: call.tool, status: "approved", by: "member@co.com" });
		// The held call replays the same way whatever happens to it (prompt caching), and no message is re-asked.
		expect(context.session.turns.at(-1)?.reply).toBe("[Held for approval: crm.send_sms]");
		expect(context.messages.some((m) => m.id === turn.triggerId)).toBe(false);

		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toEqual(call);
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
		await t.mutation(internal.approvals.finish, { approvalId, result: '{"sent":true}' });
		const [mine] = await member.query(api.approvals.forReply, { replyId: turn.replyId! });
		expect(mine).toMatchObject({ status: "done", result: '{"sent":true}' });
	});

	it("keeps a turn, its connectors and its approval in their workspace when the person switches", async () => {
		const { t, owner, member } = await ownerAndMember();
		const acme = await workspaceOf(owner);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "k" } });
		const chatId = (await generalOf(member))._id;
		const { turn, approvalId, card } = await holdCall(t, member, chatId);

		// The member also runs a workspace of their own, and switches to it on every device.
		const side = (await sideWorkspace(t, "member@co.com")).workspaceId;
		await member.mutation(api.workspace.switchTo, { to: side });
		const userId = await meOf(member);
		expect(await t.query(internal.connectors.forTurn, { userId, workspaceId: side, connectorIds: ["crm"] })).toEqual([]);

		// Deciding from a window with the side workspace open finds nothing there...
		await expect(
			inWorkspace(member, side).mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true }),
		).rejects.toThrow("not found");
		// ...from Acme's, it resumes in Acme, acting as Acme's member with Acme's connection.
		await inWorkspace(member, acme).mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true });
		const next = (await turnsOf(t)).at(-1)!;
		expect(next).toMatchObject({ status: "running", approvalId, workspaceId: acme });
		const context = await t.query(internal.turns.turnContext, { turnId: next._id });
		expect(context.member).toMatchObject({ userId, workspaceId: acme, role: "member" });
		expect(await t.query(internal.connectors.forTurn, { userId, workspaceId: context.member.workspaceId, connectorIds: ["crm"] })).toHaveLength(1);
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toEqual(call);
		expect(turn.workspaceId).toBe(acme);
	});

	it("runs nothing if the stored call no longer matches what was approved", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { approvalId, card } = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true });
		const next = (await turnsOf(t)).at(-1)!;
		await t.run((ctx) => ctx.db.patch(approvalId, { input: canonicalJson({ ...call.input, to: "+15550199" }) }));
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
		const row = await t.run((ctx) => ctx.db.get(approvalId));
		expect(row).toMatchObject({ status: "failed", error: "The stored action no longer matches what was approved." });
	});

	it("doesn't leave an approval running when its turn ends without finishing it", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const first = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId: first.approvalId, hash: first.card.hash, approve: true });
		await t.mutation(internal.turns.finishReply, { turnId: (await turnsOf(t)).at(-1)!._id, error: "Boom" });
		expect(await t.run((ctx) => ctx.db.get(first.approvalId))).toMatchObject({ status: "failed", error: expect.stringContaining("before running it") });

		const second = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId: second.approvalId, hash: second.card.hash, approve: true });
		const next = (await turnsOf(t)).at(-1)!;
		await t.mutation(internal.approvals.claim, { approvalId: second.approvalId, turnId: next._id });
		await t.mutation(internal.turns.finishReply, { turnId: next._id, error: "Timed out" });
		expect(await t.run((ctx) => ctx.db.get(second.approvalId))).toMatchObject({ status: "failed", error: expect.stringContaining("may or may not have happened") });
	});

	it("tells the agent about a denial and runs nothing", async () => {
		const { t, member } = await ownerAndMember();
		const chatId = (await generalOf(member))._id;
		const { approvalId, card } = await holdCall(t, member, chatId);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: false });
		const next = (await turnsOf(t)).at(-1)!;
		expect(next).toMatchObject({ status: "running", approvalId });
		expect((await t.query(internal.turns.turnContext, { turnId: next._id })).approval?.status).toBe("denied");
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
	});
});

describe("permissions", () => {
	const sms = { tool: "crm.send_sms", input: { to: "+15550100", body: "See you at 3" } };

	/** CRM installed and listed, Companybot granted it. */
	async function setup() {
		const { t, owner, member } = await ownerAndMember();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		const workspaceId = await t.run(async (ctx) => (await ctx.db.query("workspaces").first())!._id);
		await t.mutation(internal.permissions.saveTools, {
			workspaceId,
			connectorId: "crm",
			tools: [
				{ name: "send_sms", description: "Text someone", risk: "outside" },
				{ name: "find_leads", description: "Find leads", risk: "none" },
				{ name: "charge_card", title: "Charge a customer's card", description: "Charge a card", risk: "locked" },
			],
		});
		const { companybot } = await agentsOf(owner);
		await t.run((ctx) => ctx.db.patch(companybot._id, { tools: [...companybot.tools, "crm.*"] }));
		return { t, owner, member, companybot };
	}

	/** `as` asks Companybot in #general; returns the running turn (the test plays the runner). */
	async function ask(t: ReturnType<typeof convexTest>, as: As) {
		const { companybot } = await agentsOf(as);
		const chatId = (await generalOf(as))._id;
		await as.mutation(api.messages.send, { chatId, text: "@Companybot text Bob", mentions: { userIds: [], agentIds: [companybot._id] } });
		await cancelScheduled(t);
		return (await turnsOf(t)).at(-1)!;
	}
	const cancelScheduled = (t: ReturnType<typeof convexTest>) =>
		t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect())
				if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
		});
	const check = (t: ReturnType<typeof convexTest>, turnId: Id<"agentTurns">, action = sms.tool, risk: "none" | "outside" | "locked" = "outside") =>
		t.query(internal.permissions.check, { turnId, action, risk });

	it("asks by default, and a person's Always applies to their calls only, from the very next call", async () => {
		const { t, owner, member } = await setup();
		const turn = await ask(t, member);
		expect((await check(t, turn._id)).decision).toEqual({ type: "ask", canAlways: true });
		expect((await check(t, turn._id, "crm.find_leads", "none")).decision).toEqual({ type: "run" });

		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		const allowed = await check(t, turn._id);
		expect(allowed.decision).toEqual({ type: "run", via: "always" });
		expect(allowed.allowed).toMatchObject({ how: "always", by: await meOf(member) });

		// The owner's turn: a member's grant never reaches anyone else.
		await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		const theirs = await ask(t, owner);
		expect((await check(t, theirs._id)).decision).toEqual({ type: "ask", canAlways: true });
		await t.mutation(internal.turns.finishReply, { turnId: theirs._id });

		// Revoked: the next call asks again.
		const again = await ask(t, member);
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "ask" });
		expect((await check(t, again._id)).decision).toEqual({ type: "ask", canAlways: true });
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "never" });
		expect((await check(t, again._id)).decision).toEqual({ type: "deny", by: "person" });
		expect((await check(t, again._id, "crm.find_leads", "none")).decision).toEqual({ type: "run" });
	});

	it("lets owners lock actions for everyone, and lock wins over a person's rule", async () => {
		const { t, owner, member } = await setup();
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		await expect(member.mutation(api.permissions.setLock, { action: sms.tool, lock: "block" })).rejects.toThrow("permission");
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: "ask" });
		const turn = await ask(t, member);
		expect((await check(t, turn._id)).decision).toEqual({ type: "ask", canAlways: false });
		await expect(member.mutation(api.permissions.set, { action: sms.tool, setting: "always" })).rejects.toThrow("always asks");
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: "block" });
		expect((await check(t, turn._id)).decision).toEqual({ type: "deny", by: "owner" });
		// Owners can lock reads too (labels are the server's claim).
		await owner.mutation(api.permissions.setLock, { action: "crm.find_leads", lock: "ask" });
		expect((await check(t, turn._id, "crm.find_leads", "none")).decision).toEqual({ type: "ask", canAlways: false });
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: null });
		expect((await check(t, turn._id)).decision).toEqual({ type: "run", via: "always" });
	});

	it("never offers Always on locked actions (payments, deletes, bulk sends) unless an owner lifts it", async () => {
		const { t, owner, member } = await setup();
		await expect(member.mutation(api.permissions.set, { action: "crm.charge_card", setting: "always" })).rejects.toThrow("always asks");
		const listed = await member.query(api.permissions.actions, { connectorId: "crm" });
		// Named by the server's title when it gives one, else from the tool's name.
		expect(listed.find((a) => a.action === "crm.charge_card")).toMatchObject({ label: "Charge a customer's card", canAlways: false, result: "ask" });
		expect(listed.find((a) => a.action === "crm.send_sms")?.label).toBe("Send SMS");
		expect(listed.find((a) => a.action === "crm.send_sms")).toMatchObject({
			canAlways: true,
			alwaysText: expect.stringContaining("Always allow: agents can send SMS with the workspace's CRM without asking you first"),
		});
		await owner.mutation(api.permissions.setLock, { action: "crm.charge_card", lock: "none" });
		await member.mutation(api.permissions.set, { action: "crm.charge_card", setting: "always" });
		const turn = await ask(t, member);
		expect((await check(t, turn._id, "crm.charge_card", "locked")).decision).toEqual({ type: "run", via: "always" });
	});

	/** Holds `sms` in a member's reply, like the runner does. */
	async function hold(t: ReturnType<typeof convexTest>, as: As, risk: "outside" | "locked" = "outside") {
		const turn = await ask(t, as);
		await t.mutation(internal.turns.savePrompt, { turnId: turn._id, prompt: "Reply to this message: text Bob" });
		const approvalId = await t.mutation(internal.approvals.request, { turnId: turn._id, callId: "c1", tool: sms.tool, input: canonicalJson(sms.input), risk });
		await t.mutation(internal.turns.updateReply, { replyId: turn.replyId!, text: "", parts: [{ type: "approval", id: "c1", approvalId, tool: sms.tool }] });
		await t.mutation(internal.turns.finishReply, { turnId: turn._id });
		const [card] = await as.query(api.approvals.forReply, { replyId: turn.replyId! });
		return { turn, approvalId, card: card! };
	}

	it("saves a rule when the card's Always allow is chosen, says plainly what it covers, and runs the call", async () => {
		const { t, owner, member } = await setup();
		const { approvalId, card, turn } = await hold(t, member);
		expect(card.ask).toBe("I'd like to send an SMS to +15550100 with the workspace's CRM.");
		expect(card.alwaysText).toContain("without asking you first");
		// Others don't get the offer.
		expect((await owner.query(api.approvals.forReply, { replyId: turn.replyId! }))[0]?.alwaysText).toBeNull();
		// Still locked to the exact call.
		const other = await approvalHash(sms.tool, { ...sms.input, body: "x" });
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: other, approve: true, always: true })).rejects.toThrow("isn't the one");
		expect(await member.query(api.permissions.mine)).toEqual([]);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: true });
		expect((await member.query(api.permissions.mine))!).toMatchObject([{ action: sms.tool, setting: "always", automation: null }]);
		const next = (await turnsOf(t)).at(-1)!;
		expect((await t.query(internal.turns.turnContext, { turnId: next._id })).approval).toMatchObject({ always: true });
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toEqual(sms);
	});

	it("doesn't offer or accept Always allow on locked actions; old apps' Approve still works", async () => {
		const { t, member } = await setup();
		const { approvalId, card } = await hold(t, member, "locked");
		expect(card.alwaysText).toBeNull();
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true, always: true })).rejects.toThrow("isn't available");
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true });
		expect(await member.query(api.permissions.mine)).toEqual([]);
	});

	it("doesn't run an approved call that was blocked before it ran", async () => {
		const { t, owner, member } = await setup();
		const { approvalId, card } = await hold(t, member);
		await member.mutation(api.approvals.decide, { approvalId, hash: card.hash, approve: true });
		await owner.mutation(api.permissions.setLock, { action: sms.tool, lock: "block" });
		const next = (await turnsOf(t)).at(-1)!;
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: next._id })).toBeNull();
		expect(await t.run((ctx) => ctx.db.get(approvalId))).toMatchObject({ status: "failed", error: expect.stringContaining("blocked") });
	});

	it("asks once when turning an automation on; grants cover that automation's runs only, and turning off takes them back", async () => {
		const { t, member, companybot } = await setup();
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		const listed = await member.query(api.permissions.forAutomation, { automationId: id });
		expect(listed.map((a) => [a.action, a.state, a.allowed])).toEqual([
			["crm.send_sms", "ask", false],
			["crm.charge_card", "locked", false],
		]);
		expect(listed[0]!.alwaysText).toContain("when running Follow up without asking you first");
		await member.mutation(api.permissions.allowForAutomation, { automationId: id, actions: ["crm.send_sms", "crm.charge_card"] });
		expect((await member.query(api.permissions.forAutomation, { automationId: id })).map((a) => a.allowed)).toEqual([true, false]);

		await member.mutation(api.automations.runNow, { automationId: id });
		await cancelScheduled(t);
		const run = (await turnsOf(t)).at(-1)!;
		const allowed = await check(t, run._id);
		expect(allowed.decision).toEqual({ type: "run", via: "automation" });
		expect(allowed.allowed).toMatchObject({ how: "automation", automation: "Follow up" });
		expect((await check(t, run._id, "crm.charge_card", "locked")).decision).toEqual({ type: "ask", canAlways: false });
		// Never still wins over the grant.
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "never" });
		expect((await check(t, run._id)).decision).toEqual({ type: "deny", by: "person" });
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "ask" });
		await t.mutation(internal.turns.finishReply, { turnId: run._id });

		// Outside the automation, the same person is still asked.
		const plain = await ask(t, member);
		expect((await check(t, plain._id)).decision).toEqual({ type: "ask", canAlways: true });
		await t.mutation(internal.turns.finishReply, { turnId: plain._id });

		await member.mutation(api.automations.subscribe, { automationId: id, on: false });
		expect(await member.query(api.permissions.mine)).toEqual([]);
	});

	it("logs how each auto-allowed call was allowed, linked to the rule, and forgets rules on uninstall", async () => {
		const { t, owner, member } = await setup();
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		const turn = await ask(t, member);
		const { allowed } = await check(t, turn._id);
		await t.mutation(internal.activity.log, { turnId: turn._id, callId: "c1", tool: sms.tool, changes: true, input: "{}", output: "{}", allowed });
		const [entry] = await member.query(api.activity.list, {});
		expect(entry?.allowed).toMatchObject({ how: "always", by: "member@co.com", ruleStillOn: true });
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "ask" });
		expect((await member.query(api.activity.list, {}))[0]?.allowed?.ruleStillOn).toBe(false);

		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: false });
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		expect(await member.query(api.permissions.mine)).toEqual([]);
	});

	it("never widens an automation's Always allow to a person-wide rule once the automation is deleted", async () => {
		const { t, member, companybot } = await setup();
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		await member.mutation(api.automations.runNow, { automationId: id });
		await cancelScheduled(t);
		const run = (await turnsOf(t)).at(-1)!;
		const approvalId = await t.mutation(internal.approvals.request, { turnId: run._id, callId: "c1", tool: sms.tool, input: canonicalJson(sms.input), risk: "outside" });
		await t.mutation(internal.turns.updateReply, { replyId: run.replyId!, text: "", parts: [{ type: "approval", id: "c1", approvalId, tool: sms.tool }] });
		await t.mutation(internal.turns.finishReply, { turnId: run._id });
		const [card] = await member.query(api.approvals.forReply, { replyId: run.replyId! });
		expect(card!.alwaysText).toContain("when running Follow up");

		await member.mutation(api.automations.remove, { automationId: id });
		expect((await member.query(api.approvals.forReply, { replyId: run.replyId! }))[0]!.alwaysText).toBeNull();
		await expect(member.mutation(api.approvals.decide, { approvalId, hash: card!.hash, approve: true, always: true })).rejects.toThrow("isn't available");
		expect(await member.query(api.permissions.mine)).toEqual([]);
		// Allowing once still works, and a normal chat call still asks.
		await member.mutation(api.approvals.decide, { approvalId, hash: card!.hash, approve: true });
		await t.mutation(internal.turns.finishReply, { turnId: (await turnsOf(t)).at(-1)!._id });
		const plain = await ask(t, member);
		expect((await check(t, plain._id)).decision).toEqual({ type: "ask", canAlways: true });
	});

	it("forgets a removed member's rules, so rejoining starts strict", async () => {
		const { t, owner, member, companybot } = await setup();
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await member.mutation(api.permissions.allowForAutomation, { automationId: id, actions: [sms.tool] });
		await member.mutation(api.permissions.set, { action: sms.tool, setting: "always" });
		expect(await member.query(api.permissions.mine)).toHaveLength(2);
		const userId = await meOf(member);
		const row = (await owner.query(api.workspace.team))!.members.find((m) => m.userId === userId)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		expect(await t.run((ctx) => ctx.db.query("permissionRules").collect())).toEqual([]);
	});

	it("hides creator-only automations' actions from others, and refuses their grants", async () => {
		const { t, owner, member, companybot } = await setup();
		const config = { name: "Private", prompt: "Text my leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		expect(await member.query(api.permissions.forAutomation, { automationId: id })).not.toEqual([]);
		expect(await owner.query(api.permissions.forAutomation, { automationId: id })).toEqual([]);
		await expect(owner.mutation(api.permissions.allowForAutomation, { automationId: id, actions: [sms.tool] })).rejects.toThrow("not found");
		expect(await t.run((ctx) => ctx.db.query("permissionRules").collect())).toEqual([]);
	});

	it("only offers an automation the tools its agent is granted, not the whole connector", async () => {
		const { t, member, companybot } = await setup();
		await t.run((ctx) => ctx.db.patch(companybot._id, { tools: [...companybot.tools.filter((x) => x !== "crm.*"), sms.tool] }));
		const config = { name: "Follow up", prompt: "Text new leads.", trigger: { type: "webhook" as const } };
		const id = await member.mutation(api.automations.create, { config, agentId: companybot._id, audience: "creator", timeZone: "UTC" });
		expect((await member.query(api.permissions.forAutomation, { automationId: id })).map((a) => a.action)).toEqual([sms.tool]);
		await member.mutation(api.permissions.allowForAutomation, { automationId: id, actions: [sms.tool, "crm.charge_card"] });
		expect((await member.query(api.permissions.mine))!.map((r) => r.action)).toEqual([sms.tool]);
	});
});
