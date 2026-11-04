import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import { type Edge, type Lifecycle, edgesOf, lifecycle } from "../convex/lifecycle";
import { memberOf } from "../convex/lib";
import schema from "../convex/schema";
import { agentTurn, generalOf, newTest, noMentions, settle, ownerAndMember, sideWorkspace, signIn, turnsOf, workspaceOf, identityOf, addMember, builtInRoleIn, messagesIn } from "./helpers";
import "./connectorFixtures";
import { person } from "./person";
import { defaultAgents } from "@companybot/core";

afterEach(() => void vi.useRealTimers());

const tables = Object.keys(schema.tables) as TableNames[];
const indexesOf = (table: TableNames) =>
	new Map((schema.tables[table] as unknown as { " indexes"(): { indexDescriptor: string; fields: string[] }[] })[" indexes"]().map((i) => [i.indexDescriptor, i.fields]));
const scopes = ["role", "workspace", "member", "user", "connectorInstall", "automationInstall", "page", "record", "database", "field", "channel", "agent"] as const;

describe("the lifecycle registry", () => {
	it("lists every table, so a new one fails until someone decides what happens to its rows", () => {
		expect(Object.keys(lifecycle).sort()).toEqual([...tables].sort());
		for (const table of tables) {
			const rules = lifecycle[table] as Lifecycle<TableNames>;
			const decided = scopes.some((s) => rules[s]) || rules.childOf || rules.keep;
			expect(decided, `${table}: list what happens to its rows, or why they stay (keep)`).toBeTruthy();
		}
	});

	it("names only indexes that exist, by their leading fields", () => {
		for (const table of tables) {
			const rules = lifecycle[table] as Lifecycle<TableNames>;
			for (const scope of scopes) {
				const edge = rules[scope];
				if (!edge) continue;
				const fields = indexesOf(table).get((edge as Edge<TableNames>).index as string);
				expect(fields, `${table}.${String((edge as Edge<TableNames>).index)}`).toBeDefined();
				const eq = (edge as Edge<TableNames>).eq.map((k) => (Array.isArray(k) ? k[0] : k));
				expect(fields!.slice(0, eq.length), `${table} ${scope}`).toEqual(eq);
			}
			if (rules.childOf) {
				expect(indexesOf(table).get(rules.childOf.index as string)?.[0], `${table} childOf`).toBe(rules.childOf.field);
				// One level: a child's parent is never a child itself.
				expect((lifecycle[rules.childOf.table] as Lifecycle<TableNames>).childOf, `${table}'s parent`).toBeUndefined();
			}
		}
	});

	it("reaches every table holding a workspaceId when a workspace goes", () => {
		const reached = new Set(edgesOf("workspace").map((e) => e.table));
		for (const table of tables) {
			const fields = (schema.tables[table] as unknown as { validator: { fields?: Record<string, unknown> } }).validator.fields ?? {};
			if (!("workspaceId" in fields) || table === "cascades") continue;
			const rules = lifecycle[table] as Lifecycle<TableNames>;
			expect(reached.has(table) || rules.childOf || rules.keep, `${table} has a workspaceId: delete it with the workspace, or say why not`).toBeTruthy();
		}
	});
});

// ---- Seeded: rows in every table, then each kind of deletion ----

type T = ReturnType<typeof convexTest>;
type Row = { _id: string } & Record<string, unknown>;

/** Every row of every table, by id. */
async function dump(t: T) {
	const rows = await t.run(async (ctx) => {
		const out: [string, { table: TableNames; row: Row }][] = [];
		for (const table of tables) for (const row of await ctx.db.query(table).collect()) out.push([row._id, { table, row: row as unknown as Row }]);
		return out;
	});
	return new Map(rows);
}

/**
 * Fills a workspace with a row in every table it can have. Returns the rows that are the
 * member's alone here: what removing them must delete, and nothing else.
 */
async function seed(t: T, workspaceId: Id<"workspaces">, ownerId: Id<"users">, memberId: Id<"users">) {
	return t.run(async (ctx) => {
		const mine: string[] = [];
		mine.push(await ctx.db.insert("arrangements", { workspaceId, userId: memberId, list: "tabs", ids: ["chat"] }));
		await ctx.db.insert("arrangements", { workspaceId, list: "channels", ids: [] });
		const now = Date.now();
		const config = { name: "Helper", description: "", instructions: "Help.", model: "anthropic/claude-haiku-5.5", tools: [] };
		const agentId = await ctx.db.insert("agents", { workspaceId, ...config, archived: false, version: 1, updatedAt: now, updatedBy: memberId });
		await ctx.db.insert("agentVersions", { agentId, version: 1, config, savedBy: memberId });
		await ctx.db.insert("invites", { workspaceId, email: "next@co.com", roles: [await builtInRoleIn(ctx, workspaceId, "member")], invitedBy: ownerId });
		await ctx.db.insert("inviteEmails", { workspaceId, email: "next@co.com" });
		// Not the member's alone: removal leaves a pending upload to the sweep (images.ts).
		await ctx.db.insert("uploads", { storageId: await ctx.storage.store(new Blob(["x"])), userId: memberId, workspaceId, createdAt: now });
		const memory = { workspaceId, agentId, content: "Note", updatedAt: now, version: 1 };
		await ctx.db.insert("memories", { ...memory, scope: "workspace", ownerId: null, updatedBy: memberId });
		await ctx.db.insert("memories", { ...memory, scope: "personal", ownerId, updatedBy: ownerId });
		const personal = await ctx.db.insert("memories", { ...memory, scope: "personal", ownerId: memberId, updatedBy: memberId });
		mine.push(personal, await ctx.db.insert("memoryVersions", { memoryId: personal, version: 1, content: "Before", savedBy: memberId, savedAt: now }));

		const connectorInstallId = await ctx.db.insert("connectorInstalls", { workspaceId, connectorId: "notes", roles: [await builtInRoleIn(ctx, workspaceId, "member")], installedBy: ownerId });
		await ctx.db.insert("connectorSourceLabels", { workspaceId, installId: connectorInstallId, name: "Notes" });
		const connection = { workspaceId, connectorId: "notes", credentials: "sealed" };
		mine.push(await ctx.db.insert("connectorConnections", { ...connection, userId: memberId, connectedBy: memberId }));
		await ctx.db.insert("connectorConnections", { ...connection, userId: ownerId, connectedBy: ownerId });
		await ctx.db.insert("connectorConnections", { ...connection, connectorId: "crm", userId: null, connectedBy: memberId });
		await ctx.db.insert("connectorTools", { workspaceId, connectorId: "notes", tools: [] });
		const memberRowId = (await ctx.db.query("members").collect()).find((r) => r.userId === memberId && r.workspaceId === workspaceId)?._id;
		const flow = { connectorId: "notes", userId: memberId, workspaceId, memberId: memberRowId, connectorInstallId, data: "sealed", expiresAt: now + 60_000 };
		mine.push(await ctx.db.insert("connectorOAuthFlows", { ...flow, state: `s-${workspaceId}` }));
		const made = { version: 1, updatedBy: memberId, updatedAt: now };
		await ctx.db.insert("skillInstalls", { audience: "team", workspaceId, skillId: "custom-skill", custom: { name: "Skill", createdBy: memberId, description: "d", instructions: "i", ...made } });

		const chat = { workspaceId, archived: false, createdBy: ownerId, lastMessageAt: now };
		const channel = await ctx.db.insert("chats", { ...chat, kind: "channel", name: "board", private: true });
		const dm = await ctx.db.insert("chats", { ...chat, kind: "dm", private: true, dmKey: `u:${ownerId},u:${memberId}` });
		await ctx.db.insert("chatMembers", { chatId: channel, workspaceId, userId: ownerId });
		mine.push(await ctx.db.insert("chatMembers", { chatId: channel, workspaceId, userId: memberId }));
		await ctx.db.insert("chatMembers", { chatId: channel, workspaceId, agentId });
		await ctx.db.insert("chatMembers", { chatId: dm, workspaceId, userId: memberId });
		const message = { chatId: channel, workspaceId, parts: [], status: "done" as const };
		const said = await ctx.db.insert("chatMessages", { ...message, authorUserId: memberId, text: "Hi", mentions: { userIds: [], agentIds: [] } });
		const mention = await ctx.db.insert("chatMessages", { ...message, authorUserId: ownerId, text: "@member", mentions: { userIds: [memberId], agentIds: [] } });
		mine.push(await ctx.db.insert("userMentions", { userId: memberId, chatId: channel, messageId: mention, at: now }));
		mine.push(await ctx.db.insert("typing", { workspaceId, chatId: channel, userId: memberId, at: now }));
		await ctx.db.insert("replyStreams", { messageId: said, text: "Hi", parts: [] });
		await ctx.db.insert("linkPreviews", { workspaceId, url: "https://example.com/", title: "Example", image: await ctx.storage.store(new Blob(["x"])), fetchedAt: now });
		// More reactions than one cascade run deletes, so a message's children span runs.
		for (let i = 0; i < 150; i++) await ctx.db.insert("reactions", { messageId: said, chatId: channel, emoji: `e${i}`, userId: memberId });

		const turn = { workspaceId, chatId: channel, agentId, triggerId: said, actorId: memberId };
		const turnId = await ctx.db.insert("agentTurns", { ...turn, replyId: said, status: "done" });
		const sessionId = await ctx.db.insert("agentSessions", { workspaceId, agentId, chatId: channel });
		await ctx.db.insert("agentChains", { workspaceId, actorId: memberId, chatId: channel, turns: 2, hops: 0, pairs: [], epoch: 0, status: "running" });
		await ctx.db.patch(turnId, { sessionId });
		const call = { workspaceId, agentId, actorId: memberId, chatId: channel, turnId, replyId: said, callId: "c1", tool: "crm.sms", input: "{}" };
		// What the agent got back for them: only they see it.
		await ctx.db.insert("agentActivity", { ...call, changes: true, status: "done", output: "their inbox" });
		await ctx.db.insert("toolReceipts", { turnId, callId: "c1", actorId: memberId, state: "done", output: "their result" });
		await ctx.db.insert("turnSteps", { workspaceId, turnId, actorId: memberId, messages: JSON.stringify([{ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "crm_sms", output: { type: "text", value: "their inbox" } }] }]) });
		await ctx.db.insert("approvals", { ...call, hash: "h", status: "done", result: "their inbox", expiresAt: now + 60_000 });

		// The workspace's bill: stays when a member goes or an account is erased, goes with the workspace.
		await ctx.db.insert("usage", { workspaceId, month: "2026-10", userId: memberId, agentId, kind: "chat", model: "openai/gpt-6-luna", costUsd: 0.1 });
		await ctx.db.insert("imageHolds", { workspaceId, costUsd: 0.04 });

		const install = { workspaceId, agentId, enabled: true, timeZone: "UTC" };
		const trigger = { type: "webhook" as const };
		const justMine = await ctx.db.insert("automationInstalls", {
			...install, automationId: "custom-mine", installedBy: memberId, audience: "creator", webhookToken: `w-${workspaceId}`, custom: { name: "Mine", prompt: "p", trigger, ...made },
		});
		mine.push(justMine, await ctx.db.insert("automationEvents", { installId: justMine, eventId: "e1" }));
		mine.push(await ctx.db.insert("permissionRules", { workspaceId, userId: memberId, action: "crm.sms", automationInstallId: justMine, setting: "always", setAt: now }));
		const shared = await ctx.db.insert("automationInstalls", { ...install, automationId: "custom-shared", installedBy: ownerId, audience: "subscribers", custom: { name: "Shared", prompt: "p", trigger, ...made } });
		await ctx.db.insert("automationSubscriptions", { installId: shared, userId: ownerId });
		mine.push(await ctx.db.insert("automationSubscriptions", { installId: shared, userId: memberId }));
		await ctx.db.insert("automationEvents", { installId: shared, eventId: "e1" });

		mine.push(await ctx.db.insert("permissionRules", { workspaceId, userId: memberId, action: "crm.sms", setting: "always", setAt: now }));
		await ctx.db.insert("permissionRules", { workspaceId, userId: ownerId, action: "notes.read", connectorInstallId, setting: "never", setAt: now });
		await ctx.db.insert("permissionLocks", { workspaceId, action: "notes.read", connectorInstallId, lock: "ask", setBy: memberId, setAt: now });

		const typeId = await ctx.db.insert("recordTypes", { workspaceId, key: "job", name: "Job", plural: "Jobs", archived: false, createdBy: memberId, updatedAt: now });
		await ctx.db.insert("databaseViews", { workspaceId, typeId, name: "All jobs", filters: [], columns: ["name"], version: 1 });
		const fieldId = await ctx.db.insert("recordFields", { workspaceId, typeId, key: "name", label: "Name", kind: "text", position: 0, archived: false, createdBy: memberId, updatedAt: now });
		const recordId = await ctx.db.insert("records", { workspaceId, typeId, title: "Roof", values: { name: "Roof" }, searchText: "roof", archived: false, createdBy: memberId, updatedAt: now, updatedBy: memberId });
		await ctx.db.insert("recordValues", { recordId, fieldId, str: "roof", at: now });
		await ctx.db.insert("recordHistory", { workspaceId, typeId, recordId, action: "created", changes: [], userId: memberId });
		await ctx.db.insert("recordMentions", { recordId, messageId: said, chatId: channel });
		mine.push(await ctx.db.insert("wakeups", { workspaceId, agentId, chatId: channel, actorId: memberId, createdBy: memberId, note: "Chase it", recordId, typeId, foreign: false, status: "pending", at: now + 60_000 }));
		const pageId = await ctx.db.insert("pages", { workspaceId, recordId, title: "", archived: false, createdBy: memberId, updatedAt: now, updatedBy: memberId });
		await ctx.db.insert("pageVersions", { pageId, n: 1, version: 2, userId: memberId, editedAt: now });
		await ctx.db.insert("pageImages", { workspaceId, pageId, storageId: await ctx.storage.store(new Blob(["x"])), url: `https://x.convex.cloud/api/storage/${pageId}` });
		await ctx.db.insert("pageMoves", { workspaceId, pageId, n: 1, userId: memberId, from: "Pages", to: "Wiki" });
		const trashedId = await ctx.db.insert("records", { workspaceId, typeId, title: "Old", values: { name: "Old" }, searchText: "old", archived: true, createdBy: memberId, updatedAt: now, updatedBy: memberId });
		await ctx.db.insert("trash", { workspaceId, kind: "record", itemId: trashedId, name: "Old", typeId, deletedBy: memberId, deletedAt: now });
		return mine;
	});
}

/** Sign-in rows for one person, and the ones that name nobody. */
async function seedAuth(t: T, userId: Id<"users">, email: string) {
	await t.run(async (ctx) => {
		const accountId = await ctx.db.insert("authAccounts", { userId, provider: "email-code", providerAccountId: email });
		await ctx.db.insert("authVerificationCodes", { accountId, provider: "email-code", code: "hash", expirationTime: Date.now() + 60_000 });
		const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60_000 });
		await ctx.db.insert("authRefreshTokens", { sessionId, expirationTime: Date.now() + 60_000 });
		await ctx.db.insert("authVerifiers", { signature: email });
		await ctx.db.insert("authRateLimits", { identifier: email, lastAttemptTime: Date.now(), attemptsLeft: 3 });
		await ctx.db.insert("localSignInCodes", { email, code: "123456" });
	});
}

/** Owner A and owner B each with a workspace, and a member in both. Every table gets rows. */
async function world() {
	const t = newTest();
	const a = await signIn(t, "a@co.com");
	const b = await signIn(t, "b@co.com");
	// Shared by every workspace.
	await t.mutation(internal.modelCatalog.save, { models: [{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "anthropic" }] });
	const [A, B] = [await workspaceOf(a), await workspaceOf(b)];
	await a.in(A).mutation(api.workspace.invite, { email: "m@co.com", role: "member" });
	await b.in(B).mutation(api.workspace.invite, { email: "m@co.com", role: "member" });
	const m = await signIn(t, "m@co.com");
	await m.mutation(api.workspace.switchTo, { to: A });
	for (const [userId, email] of [[a.userId, "a@co.com"], [b.userId, "b@co.com"], [m.userId, "m@co.com"]] as const) await seedAuth(t, userId, email);
	const mineIn = { [A]: await seed(t, A, a.userId, m.userId), [B]: await seed(t, B, b.userId, m.userId) };
	return { t, a: a.in(A), b: b.in(B), m, A, B, mineIn };
}

const memberRow = (t: T, workspaceId: Id<"workspaces">, userId: Id<"users">) =>
	t.run(async (ctx) => (await ctx.db.query("members").collect()).find((r) => r.userId === userId && r.workspaceId === workspaceId)!);

/** Someone's seats in a workspace's channels (#general, from joining). */
const seatsIn = (rows: Awaited<ReturnType<typeof dump>>, workspaceId: string, userId: string) =>
	[...rows.values()]
		.filter(({ table, row }) => table === "chatMembers" && row.workspaceId === workspaceId && row.userId === userId && rows.get(row.chatId as string)!.row.kind === "channel")
		.map(({ row }) => row._id);

/** Rows of `workspaceId`: its own, and their children (lifecycle childOf). */
function rowsOf(rows: Awaited<ReturnType<typeof dump>>, workspaceId: string) {
	const owned = new Set<string>([workspaceId]);
	for (const [id, { row }] of rows) if (row.workspaceId === workspaceId) owned.add(id);
	for (const [id, { table, row }] of rows) {
		const parent = (lifecycle[table] as Lifecycle<TableNames>).childOf;
		if (parent && owned.has(row[parent.field] as string)) owned.add(id);
	}
	return owned;
}

/** Tables a workspace's deletion leaves alone, with a written reason (`keep`). */
const keptWhenWorkspaceGoes = (table: TableNames) => {
	const rules = lifecycle[table] as Lifecycle<TableNames>;
	return table !== "workspaces" && !rules.workspace && !rules.childOf;
};

function diff(before: Awaited<ReturnType<typeof dump>>, after: Awaited<ReturnType<typeof dump>>) {
	const deleted = [...before.keys()].filter((id) => !after.has(id));
	const changed = [...after.keys()].filter((id) => before.has(id) && JSON.stringify(before.get(id)!.row) !== JSON.stringify(after.get(id)!.row));
	return { deleted: new Set(deleted), changed: new Set(changed) };
}

describe("deleting a workspace", () => {
	it("ends access at once, then deletes everything of it and nothing of anyone else's", { timeout: 60_000 }, async () => {
		const { t, a, b, m, A, B } = await world();
		const general = (await generalOf(a))._id;
		// The desktop keeps these subscriptions cached after their screens unmount.
		const staleReads = async () => {
			expect(await a.in(A).query(api.workspace.settings)).toBeNull();
			expect(await a.in(A).query(api.chats.list)).toBeNull();
			expect(await a.in(A).query(api.chats.get, { chatId: general })).toBeNull();
			expect(await messagesIn(a.in(A), { chatId: general })).toEqual([]);
			expect(await a.in(A).query(api.chats.alerts)).toBeNull();
		};
		// Every live table has rows, so a cascade that missed one would show.
		const before = await dump(t);
		const seeded = new Set([...before.values()].map((r) => r.table));
		expect(tables.filter((table) => !seeded.has(table) && table !== "cascades")).toEqual([]);

		await expect(a.mutation(api.workspace.deleteWorkspace, { name: "Nope" })).rejects.toThrow("Type the workspace's name");
		await expect(m.in(A).mutation(api.workspace.deleteWorkspace, { name: "My company" })).rejects.toThrow("Only people with the");
		await a.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		// Before any cleanup has run: nobody's in it, it's off everyone's list, and its invites can't be used.
		expect(await m.in(A).query(api.workspace.me)).toMatchObject({ workspaceId: null, role: null });
		await expect(m.in(A).mutation(api.chats.createChannel, { name: "x", private: false })).rejects.toThrow();
		expect((await m.query(api.workspace.mine))!.workspaces.map((w) => w.id)).toEqual([B]);
		expect((await a.query(api.workspace.mine))!.workspaces).toEqual([]);
		await staleReads();

		await settle(t);
		await staleReads();
		const after = await dump(t);
		const owned = rowsOf(before, A);
		for (const id of owned) {
			const { table } = before.get(id)!;
			const rule = (lifecycle[table] as Lifecycle<TableNames>).workspace;
			const scrubbed = typeof rule === "object" && !!rule.scrub;
			if (after.has(id)) expect(keptWhenWorkspaceGoes(table) || scrubbed, `${table} row of the deleted workspace`).toBe(true);
		}
		// Nothing left points at it, except rows the registry keeps on purpose.
		for (const { table, row } of after.values()) {
			if (keptWhenWorkspaceGoes(table)) continue;
			const json = JSON.stringify(row);
			expect([...owned].filter((id) => id !== row._id && json.includes(id)), `${table} ${row._id}`).toEqual([]);
		}
		// Everything else is as it was, but "last used" no longer names it.
		const { changed } = diff(before, after);
		expect([...changed].map((id) => before.get(id)!.table)).toEqual(["preferences"]);
		expect(await b.query(api.workspace.me)).toMatchObject({ workspaceId: B, role: "owner" });
		expect(await t.run((ctx) => ctx.db.query("cascades").collect())).toEqual([]);
		// In no workspace now, nothing is made for them (onboarding will); then they start a fresh one.
		await a.mutation(api.workspace.ensure);
		expect((await a.query(api.workspace.mine))!.workspaces).toEqual([]);
		await a.mutation(api.workspace.setUp, { displayName: "", name: "Fresh", invites: [] });
		const fresh = (await a.query(api.workspace.mine))!.workspaces.map((w) => w.id);
		expect(fresh).toHaveLength(1);
		expect(fresh).not.toContain(A);
	});
});

describe("resetting a workspace", () => {
	it("closes it at once, deletes its content, keeps its people, roles, invites and bill, and starts it again like new", { timeout: 60_000 }, async () => {
		const { t, a, b, m, A, B } = await world();
		// A custom role someone holds (configuration: kept), a channel only it can see (its access list goes with
		// the channel), and the member's personal skill (content: deleted).
		const crew = await t.run(async (ctx) => {
			const crew = await ctx.db.insert("roles", { workspaceId: A, name: "Crew", switches: [{ permission: "records.edit", on: true }] });
			const row = (await ctx.db.query("members").collect()).find((r) => r.userId === m.userId && r.workspaceId === A)!;
			await ctx.db.patch(row._id, { roles: [...(row.roles ?? []), crew] });
			const board = (await ctx.db.query("chats").collect()).find((c) => c.workspaceId === A && c.name === "board")!;
			await ctx.db.patch(board._id, { access: [{ role: crew, level: "edit" }] });
			return crew;
		});
		await m.in(A).mutation(api.skills.create, { config: { name: "Mine", description: "d", instructions: "i" }, audience: "personal" });
		const before = await dump(t);
		await expect(a.mutation(api.workspace.resetWorkspace, { name: "Nope" })).rejects.toThrow("Type the workspace's name");
		await expect(m.in(A).mutation(api.workspace.resetWorkspace, { name: "My company" })).rejects.toThrow("Only people with the Owner role can reset the workspace");
		// Owner-only, like deleting: no role can be given it.
		await expect(a.mutation(api.roles.setPermission, { id: crew, permission: "workspace.reset", on: true })).rejects.toThrow("isn't a switch");
		vi.useFakeTimers();
		await a.mutation(api.workspace.resetWorkspace, { name: "My company" });
		// Before any cleanup has run: closed to everyone, nothing new can land in it, but it stays on their lists.
		expect(await m.in(A).query(api.workspace.me)).toMatchObject({ workspaceId: null, role: null });
		await expect(m.in(A).mutation(api.chats.createChannel, { name: "x", private: false })).rejects.toThrow();
		await expect(a.mutation(api.workspace.resetWorkspace, { name: "My company" })).rejects.toThrow();
		expect((await m.query(api.workspace.mine))!.workspaces.find((w) => w.id === A)).toMatchObject({ resetting: true });

		await settle(t);
		const after = await dump(t);
		const keptOnReset = (table: TableNames) => keptWhenWorkspaceGoes(table) || !!(lifecycle[table] as Lifecycle<TableNames>).keepOnReset || table === "workspaces";
		for (const id of rowsOf(before, A)) expect(after.has(id), `${before.get(id)!.table} row`).toBe(keptOnReset(before.get(id)!.table));
		// Of what's left, only its members (a fresh tutorial each) and itself (who reset it) changed; nothing of B's.
		const { changed } = diff(before, after);
		expect([...changed].every((id) => ["members", "workspaces"].includes(before.get(id)!.table) && rowsOf(before, A).has(id))).toBe(true);
		for (const row of [...after.values()].filter((r) => r.table === "members" && r.row.workspaceId === A)) expect(row.row.tutorial).toEqual({ done: [] });
		const ownerRole = await t.run((ctx) => builtInRoleIn(ctx, A, "owner"));
		const owner = [...after.values()].find((r) => r.table === "members" && r.row.workspaceId === A && (r.row.roles as string[]).includes(ownerRole))!.row.userId;
		// Roles and who holds which stay; the personal skill and the restricted channel went with everything else.
		expect(after.get(crew)).toEqual(before.get(crew));
		expect((await memberRow(t, A, m.userId)).roles).toContain(crew);
		expect([...after.values()].filter((r) => r.table === "skillInstalls" && r.row.workspaceId === A)).toEqual([]);
		expect(after.get(A)!.row).toMatchObject({ name: "My company", lastReset: { by: owner } });
		expect(after.get(A)!.row).not.toHaveProperty("resetting");
		expect(await t.run((ctx) => ctx.db.query("cascades").collect())).toEqual([]);

		// Like new: the default agents, #general alone with everyone in it and the welcome, a tutorial each.
		expect((await a.query(api.agents.list)).map((x) => x.name)).toEqual(defaultAgents.map((x) => x.name));
		const chats = (await m.in(A).query(api.chats.list))!;
		expect(chats.channels.map((c) => c.name)).toEqual(["general"]);
		expect(chats.dms).toEqual([]);
		const general = await generalOf(a);
		expect(general.members.filter((x) => x.type === "user").map((x) => x.id).sort()).toEqual([owner, m.userId].sort());
		expect(await messagesIn(a, { chatId: general._id })).toHaveLength(1);
		for (const who of [a, m.in(A)]) expect(await who.query(api.onboarding.tutorial)).not.toBeNull();
		expect((await a.query(api.workspace.team))!.invites.map((i) => i.email)).toEqual(["next@co.com"]);
		expect(await a.query(api.workspace.settings)).toMatchObject({ lastReset: { by: expect.any(String), at: expect.any(Number) } });
		expect(await b.query(api.workspace.me)).toMatchObject({ workspaceId: B, role: "owner" });
	});

	it("deletes in batches, staying closed until it's started again", { timeout: 60_000 }, async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		const workspaceId = await workspaceOf(owner);
		const chatId = (await generalOf(owner))._id;
		await t.run(async (ctx) => {
			for (let i = 0; i < 1_000; i++)
				await ctx.db.insert("chatMessages", { chatId, workspaceId, authorUserId: owner.userId, text: "hi", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done" });
		});
		vi.useFakeTimers();
		await owner.mutation(api.workspace.resetWorkspace, { name: "My company" });
		// Run by run, until the messages' first page has gone: the rest wait for later runs.
		const messages = () => t.run(async (ctx) => (await ctx.db.query("chatMessages").collect()).length);
		let left = await messages();
		for (let run = 0; run < 100 && left === 1_000; run++) {
			vi.runOnlyPendingTimers();
			await t.finishInProgressScheduledFunctions();
			left = await messages();
		}
		expect(left).toBeGreaterThan(0);
		expect(left).toBeLessThan(1_000);
		expect(await owner.query(api.workspace.me)).toMatchObject({ role: null });
		await settle(t);
		expect(await owner.query(api.workspace.me)).toMatchObject({ workspaceId, role: "owner" });
		expect(await t.run(async (ctx) => (await ctx.db.query("chatMessages").collect()).length)).toBe(1);
	});
});

describe("removing a member", () => {
	it("deletes what was theirs alone in that workspace, and nothing else", { timeout: 60_000 }, async () => {
		const { t, a, m, A, mineIn } = await world();
		const row = await memberRow(t, A, m.userId);
		const before = await dump(t);
		await a.mutation(api.workspace.removeMember, { id: row._id });
		await settle(t);
		const { deleted, changed } = diff(before, await dump(t));
		expect([...deleted].sort()).toEqual([...new Set([row._id, ...mineIn[A]!, ...seatsIn(before, A, m.userId)])].sort());
		expect(changed).toEqual(new Set());
	});
});

describe("the cascade runner", () => {
	it("restarts a stalled cascade, and starts over if a deploy changed the edge it was on", { timeout: 60_000 }, async () => {
		const { t, a, m, A, mineIn } = await world();
		vi.useFakeTimers();
		await a.mutation(api.workspace.removeMember, { id: (await memberRow(t, A, m.userId))._id });
		await t.run(async (ctx) => {
			for (const job of await ctx.db.query("cascades").collect()) await ctx.db.patch(job._id, { edge: "gone.by_nothing", cursor: "stale", updatedAt: 0 });
			for (const fn of await ctx.db.system.query("_scheduled_functions").collect()) if (fn.state.kind === "pending") await ctx.scheduler.cancel(fn._id);
		});
		await t.mutation(internal.cascade.resume);
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("cascades").collect())).toEqual([]);
		const left = await dump(t);
		expect(mineIn[A]!.filter((id) => left.has(id))).toEqual([]);
	});
});

describe("erasing an account", () => {
	it("leaves every workspace, deletes one they're alone in, and scrubs them to a former member", { timeout: 60_000 }, async () => {
		const { t, a, m, A, B, mineIn } = await world();
		const solo = await t.run(async (ctx) => {
			const workspaceId = await ctx.db.insert("workspaces", { name: "Solo", version: 1 });
			await addMember(ctx, { workspaceId, userId: m.userId, role: "owner" });
			return workspaceId;
		});
		await seed(t, solo, m.userId, m.userId);
		// A personal account left behind by a removal from before removals deleted them.
		const leftBehind = await t.run((ctx) =>
			ctx.db.insert("connectorConnections", { workspaceId: B, connectorId: "crm", userId: m.userId, credentials: "sealed", connectedBy: m.userId }),
		);
		const before = await dump(t);
		const sessions = new Set([...before.values()].filter((r) => r.table === "authSessions" && r.row.userId === m.userId).map((r) => r.row._id));

		await m.mutation(api.workspace.eraseAccount);
		// At once: their sign-in acts as nobody, and their email can't sign back in to this account.
		expect(await m.query(api.workspace.mine)).toBeNull();
		// Their memberships go in the cascade; until then nothing (a queued reply, an automation) can act as them.
		expect(await t.run((ctx) => memberOf(ctx, m.userId, A))).toBeNull();
		await expect(m.mutation(api.workspace.ensure)).rejects.toThrow("erased");
		await settle(t);
		const after = await dump(t);
		const { deleted, changed } = diff(before, after);

		const theirs = new Set<string>([...mineIn[A]!, ...mineIn[B]!, ...seatsIn(before, A, m.userId), ...seatsIn(before, B, m.userId), leftBehind]);
		for (const [id, { table, row }] of before) {
			const own = row.userId === m.userId && ["members", "preferences", "authAccounts", "authSessions", "connectorOAuthFlows", "uploads"].includes(table);
			const email = (table === "authRateLimits" && row.identifier === "m@co.com") || (table === "localSignInCodes" && row.email === "m@co.com");
			if (email) theirs.add(id);
			const child = (table === "authVerificationCodes" && !after.has(row.accountId as string)) || (table === "authRefreshTokens" && sessions.has(row.sessionId as string));
			// The steps their turns took hold what agents got back for them: they go with the account.
			const steps = table === "turnSteps" && row.actorId === m.userId;
			if (own || child || steps) theirs.add(id);
		}
		for (const id of rowsOf(before, solo)) if (!keptWhenWorkspaceGoes(before.get(id)!.table)) theirs.add(id);
		expect([...deleted].sort()).toEqual([...theirs].sort());
		// The account row stays for history, with nothing that names them; what agents got back for them is cleared.
		const scrubbed = [...after.values()].filter(({ table, row }) => ["agentActivity", "approvals"].includes(table) && row.actorId === m.userId).map(({ row }) => row._id);
		expect(scrubbed).toHaveLength(4);
		expect([...changed].sort()).toEqual([m.userId, ...scrubbed].sort());
		for (const id of scrubbed) expect(after.get(id)!.row).not.toHaveProperty(before.get(id)!.table === "agentActivity" ? "output" : "result");
		expect(after.get(m.userId)!.row).toEqual({ _id: m.userId, _creationTime: before.get(m.userId)!.row._creationTime, erasedAt: expect.any(Number) });
		expect((await a.query(api.workspace.team))!.members.map((x) => x.email)).toEqual(["a@co.com"]);
	});

	it("refuses while they're the only owner of a workspace with other people", async () => {
		const t = newTest();
		const owner = await signIn(t, "a@co.com");
		await owner.mutation(api.workspace.invite, { email: "m@co.com", role: "member" });
		await signIn(t, "m@co.com");
		await expect(owner.mutation(api.workspace.eraseAccount)).rejects.toThrow("only owner of My company");
		expect(await owner.query(api.workspace.me)).toMatchObject({ role: "owner" });
	});

	it("lets a sole owner erase their account while a workspace they deleted is still being cleaned up", async () => {
		const t = newTest();
		const owner = await signIn(t, "a@co.com");
		await owner.mutation(api.workspace.invite, { email: "m@co.com", role: "member" });
		await signIn(t, "m@co.com");
		vi.useFakeTimers();
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		await owner.mutation(api.workspace.eraseAccount);
		await settle(t);
	});

	it("still refuses a sole owner of a live shared workspace when another workspace is being deleted", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { workspaceId } = await sideWorkspace(t, "owner@co.com");
		await t.run((ctx) => addMember(ctx, { workspaceId, userId: member.userId, role: "member" }));
		vi.useFakeTimers();
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		await expect(owner.mutation(api.workspace.eraseAccount)).rejects.toThrow("only owner of Side gig");
		expect(await owner.in(workspaceId).query(api.workspace.me)).toMatchObject({ role: "owner", email: "owner@co.com" });
		await settle(t);
	});

	it("deletes a sole owner's workspace even if their pending invite is used before the cascade gets there", async () => {
		const t = newTest();
		const owner = await signIn(t, "a@co.com");
		const workspaceId = await workspaceOf(owner);
		await owner.mutation(api.workspace.invite, { email: "late@co.com", role: "member" });
		vi.useFakeTimers();
		await owner.mutation(api.workspace.eraseAccount);
		const late = await signIn(t, "late@co.com");
		expect((await late.query(api.workspace.mine))!.workspaces.map((w) => w.id)).not.toContain(workspaceId);
		await settle(t);
		expect(await t.run((ctx) => ctx.db.get(workspaceId))).toBeNull();
		expect(await late.query(api.workspace.me)).toMatchObject({ role: "owner" });
	});

	it("doesn't count an erased owner, so the last other owner can't leave while their membership is cleaned up", async () => {
		const t = newTest();
		const a = await signIn(t, "a@co.com");
		await a.mutation(api.workspace.invite, { email: "b@co.com", role: "owner" });
		const b = await signIn(t, "b@co.com");
		await a.mutation(api.workspace.invite, { email: "m@co.com", role: "member" });
		await signIn(t, "m@co.com");
		vi.useFakeTimers();
		await a.mutation(api.workspace.eraseAccount);
		await expect(b.mutation(api.workspace.leave)).rejects.toThrow("only owner");
		await settle(t);
		expect((await b.query(api.workspace.team))!.members.map((x) => [x.email, x.role])).toEqual([["b@co.com", "owner"], ["m@co.com", "member"]]);
	});

	it("shows what they wrote as a former member's", async () => {
		const t = newTest();
		const owner = await signIn(t, "a@co.com");
		await owner.mutation(api.workspace.invite, { email: "m@co.com", role: "member" });
		const m = await signIn(t, "m@co.com");
		const general = (await m.query(api.chats.list))!.channels[0]!._id;
		await m.mutation(api.messages.send, { chatId: general, text: "Bye", mentions: { userIds: [], agentIds: [] } });
		await m.mutation(api.workspace.eraseAccount);
		await settle(t);
		const [message] = await messagesIn(owner, { chatId: general });
		expect(message).toMatchObject({ text: "Bye", author: { type: "user", name: "Former member" } });
		// A later sign-in with the same email is someone new, in none of the old workspaces.
		const again = person(identityOf(t, await t.run((ctx) => ctx.db.insert("users", { email: "m@co.com" }))));
		await again.mutation(api.workspace.ensure);
		expect((await again.query(api.workspace.mine))!.workspaces.map((w) => w.id)).not.toContain(await workspaceOf(owner));
	});
});

describe("a sign-in from before an account was erased", () => {
	it("acts as nobody: no preferences, name, workspace or invite, before and after cleanup", { timeout: 60_000 }, async () => {
		const { t, owner, member } = await ownerAndMember();
		const general = (await generalOf(member))._id;
		await member.mutation(api.preferences.update, { displayName: "Mo" });
		await member.mutation(api.messages.send, { chatId: general, text: "Bye", mentions: noMentions });
		const workspaceId = await workspaceOf(owner);
		await member.mutation(api.workspace.eraseAccount);
		const authorOfBye = async () => (await messagesIn(owner, { chatId: general })).find((m) => m.text === "Bye")!.author;
		const refused = async () => {
			await expect(member.mutation(api.preferences.update, { displayName: "Back" })).rejects.toThrow("Not signed in");
			expect(await member.query(api.preferences.get)).toMatchObject({ displayName: "" });
			await expect(member.mutation(api.workspace.ensure)).rejects.toThrow("erased");
			await expect(member.mutation(api.workspace.switchTo, { to: workspaceId })).rejects.toThrow("not in that workspace");
			expect(await member.query(api.workspace.me)).toBeNull();
			expect(await member.query(api.workspace.mine)).toBeNull();
			// Their old name is still stored until cleanup runs, but they show as a former member at once.
			expect(await authorOfBye()).toMatchObject({ name: "Former member" });
		};
		await refused();
		// An invite to their old email isn't theirs to accept.
		await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
		const inviteId = (await t.run((ctx) => ctx.db.query("invites").first()))!._id;
		await expect(member.mutation(api.workspace.acceptInvite, { id: inviteId })).rejects.toThrow("isn't available");
		await settle(t);
		await refused();
		expect((await t.run((ctx) => ctx.db.query("preferences").collect())).map((p) => p.userId)).not.toContain(member.userId);
	});
});

describe("a sign-in to a connector", () => {
	it("only connects under the membership and install it started under, and is deleted with either", { timeout: 60_000 }, async () => {
		const { t, owner, member } = await ownerAndMember();
		const workspaceId = await workspaceOf(owner);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: true });
		const target = () => t.query(internal.connectors.connectTarget, { userId: member.userId, workspaceId, connectorId: "notes" });
		const startFlow = async (state: string, bound: Awaited<ReturnType<typeof target>>) =>
			t.mutation(internal.connectors.saveOAuthFlow, { userId: member.userId, ...bound, connectorId: "notes", state, data: "sealed" });
		const save = (bound: Awaited<ReturnType<typeof target>>) =>
			t.mutation(internal.connectors.saveConnection, { userId: member.userId, ...bound, connectorId: "notes", credentials: "sealed" });
		const flows = () => t.run((ctx) => ctx.db.query("connectorOAuthFlows").collect());

		// Started, then they're removed and rejoin before the provider sends them back.
		const before = await target();
		await startFlow("s1", before);
		await owner.mutation(api.workspace.removeMember, { id: before.memberId });
		await settle(t);
		expect(await flows()).toEqual([]);
		await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
		await member.mutation(api.workspace.ensure);
		await expect(save(before)).rejects.toThrow("Connect again");
		await expect(startFlow("s2", before)).rejects.toThrow("Connect again");

		// Started, then the connector is uninstalled and installed again.
		const rejoined = await target();
		await startFlow("s3", rejoined);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: false });
		await settle(t);
		expect(await flows()).toEqual([]);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: true });
		await expect(save(rejoined)).rejects.toThrow("Connect again");

		await save(await target());
		expect(await t.run((ctx) => ctx.db.query("connectorConnections").collect())).toHaveLength(1);

		// And a sign-in in progress goes with the workspace and the account.
		await startFlow("s4", await target());
		await member.mutation(api.workspace.eraseAccount);
		await settle(t);
		expect(await flows()).toEqual([]);
	});

	it("refuses a sign-in from before sign-ins named their membership and install", async () => {
		const { t, member } = await ownerAndMember();
		const workspaceId = await workspaceOf(member);
		await t.run((ctx) => ctx.db.insert("connectorOAuthFlows", { state: "old", connectorId: "notes", userId: member.userId, workspaceId, data: "sealed", expiresAt: Date.now() + 60_000 }));
		const page = await (await t.fetch("/oauth/callback?state=old&code=c")).text();
		expect(page).toContain("This sign-in link expired.");
		expect(await t.run((ctx) => ctx.db.query("connectorOAuthFlows").collect())).toEqual([]);
	});
});

describe("writes that land after what they belong to went", () => {
	it("doesn't save a connector's tools for an install that's gone, or in a workspace being deleted", { timeout: 60_000 }, async () => {
		const { t, owner } = await ownerAndMember();
		const workspaceId = await workspaceOf(owner);
		const install = async () => (await t.run((ctx) => ctx.db.query("connectorInstalls").first()))!._id;
		const save = (installId: Id<"connectorInstalls">) => t.mutation(internal.connectorTools.saveTools, { workspaceId, connectorId: "crm", installId, tools: [] });
		const tools = () => t.run((ctx) => ctx.db.query("connectorTools").collect());
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		const old = await install();
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: false });
		await settle(t);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await save(old);
		expect(await tools()).toEqual([]);
		await save(await install());
		expect(await tools()).toHaveLength(1);
		await t.run(async (ctx) => {
			for (const row of await ctx.db.query("connectorTools").collect()) await ctx.db.delete(row._id);
		});
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		await save(await install());
		expect(await tools()).toEqual([]);
	});

	it("starts no queued reply, logs no activity and holds no approval in a workspace being deleted", { timeout: 60_000 }, async () => {
		const { t, owner } = await ownerAndMember();
		const general = (await generalOf(owner))._id;
		const agentId = (await owner.query(api.agents.list))[0]!._id;
		const turnId = await agentTurn(t, owner, general, agentId);
		// A second ask waits behind the running one.
		await owner.mutation(api.messages.send, { chatId: general, text: "and?", mentions: { userIds: [], agentIds: [agentId] } });
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		const count = () => t.run(async (ctx) => [(await ctx.db.query("chatMessages").collect()).length, (await ctx.db.query("agentSessions").collect()).length]);
		const before = await count();
		await t.mutation(internal.activity.log, { turnId, callId: "c1", tool: "crm.send_sms", changes: true, input: "{}", output: "private" });
		await expect(t.mutation(internal.approvals.request, { turnId, callId: "c2", tool: "crm.send_sms", input: "{}", risk: "outside" })).rejects.toThrow("no longer in the workspace");
		await t.mutation(internal.turns.finishReply, { turnId });
		expect(await count()).toEqual(before);
		expect(await t.run((ctx) => ctx.db.query("agentActivity").collect())).toEqual([]);
		// Its person is gone with the workspace, so the running reply ends as an error too (turns.finishReply).
		expect((await turnsOf(t)).map((x) => x.status)).toEqual(["error", "error"]);
	});

	it("keeps a call that finishes after its person's account is erased, without what it got back for them", { timeout: 60_000 }, async () => {
		const { t, member } = await ownerAndMember();
		const general = (await generalOf(member))._id;
		const agentId = (await member.query(api.agents.list))[0]!._id;
		const turnId = await agentTurn(t, member, general, agentId);
		const { approvalId } = await t.mutation(internal.approvals.request, { turnId, callId: "c1", tool: "crm.find", input: "{}", risk: "inside" });
		await t.run((ctx) => ctx.db.patch(approvalId, { status: "running" }));
		// The external call is in flight while they erase their account, and returns after cleanup finished.
		await member.mutation(api.workspace.eraseAccount);
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("cascades").first())).toBeNull();
		await t.mutation(internal.activity.log, { turnId, callId: "c2", tool: "crm.find", changes: false, input: "{}", output: "private" });
		await t.mutation(internal.approvals.finish, { approvalId, turnId, result: "private" });
		const [activity] = await t.run((ctx) => ctx.db.query("agentActivity").collect());
		expect(activity).toMatchObject({ callId: "c2", status: "done" });
		expect(activity).not.toHaveProperty("output");
		const approval = await t.run((ctx) => ctx.db.get(approvalId));
		expect(approval).toMatchObject({ status: "done" });
		expect(approval).not.toHaveProperty("result");
	});

	it("sends no invite email once the invite is gone", async () => {
		const { t, owner } = await ownerAndMember();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.useFakeTimers();
		await owner.mutation(api.workspace.invite, { email: "gone@co.com", role: "member" });
		await owner.mutation(api.workspace.invite, { email: "kept@co.com", role: "member" });
		const gone = (await owner.query(api.workspace.team))!.invites.find((i) => i.email === "gone@co.com")!;
		await owner.mutation(api.workspace.cancelInvite, { id: gone.id });
		await settle(t);
		const sent = log.mock.calls.map(([line]) => String(line).split(":")[0]);
		log.mockRestore();
		expect(sent).toContain("Invite email to kept@co.com");
		expect(sent).not.toContain("Invite email to gone@co.com");
	});

	it("answers no webhook and runs no schedule in a workspace being deleted", { timeout: 60_000 }, async () => {
		const { t, owner } = await ownerAndMember();
		const agentId = (await owner.query(api.agents.list))[0]!._id;
		const make = (name: string, trigger: { type: "webhook" } | { type: "schedule"; cron: string }) =>
			owner.mutation(api.automations.create, { config: { name, prompt: "p", trigger }, agentId, audience: "creator", timeZone: "UTC" });
		await make("Hook", { type: "webhook" });
		await make("Daily", { type: "schedule", cron: "0 9 * * *" });
		const installs = () => t.run((ctx) => ctx.db.query("automationInstalls").collect());
		const token = (await installs()).find((i) => i.webhookToken)!.webhookToken!;
		const before = (await installs()).map((i) => i.lastScheduledAt ?? i.lastResult ?? null);
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		const reply = await t.mutation(internal.automationRuns.receive, { token, body: JSON.stringify({ id: "e1", data: {} }) });
		expect(reply.status).toBe(404);
		await t.mutation(internal.automationRuns.tick, { now: Date.UTC(2026, 9, 26, 10) });
		expect((await installs()).map((i) => i.lastScheduledAt ?? i.lastResult ?? null)).toEqual(before);
		expect(await t.run((ctx) => ctx.db.query("automationEvents").collect())).toEqual([]);
	});
});

describe("a cascade that keeps failing", () => {
	it("is marked stuck with its error, tells someone rejoining it's still cleaning up, and resumes with retry", { timeout: 60_000 }, async () => {
		const { t, owner, member } = await ownerAndMember();
		vi.useFakeTimers();
		const memberId = (await t.run((ctx) => ctx.db.query("members").collect())).find((r) => r.userId === member.userId)!._id;
		await owner.mutation(api.workspace.removeMember, { id: memberId });
		const job = async () => (await t.run((ctx) => ctx.db.query("cascades").first()))!;
		// A run that throws every time (here, a cursor it can't read), as a bug would.
		const first = edgesOf("member")[0]!;
		await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("cascades").first())!._id, { edge: `${first.table}.${String(first.index)}`, cursor: "not a cursor" }));
		vi.spyOn(console, "error").mockImplementation(() => {});
		await settle(t);
		for (let i = 0; i < 3; i++) {
			await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("cascades").first())!._id, { updatedAt: 0 }));
			await t.mutation(internal.cascade.resume);
			await settle(t);
		}
		expect(await job()).toMatchObject({ stuck: true, attempts: 3, error: expect.any(String) });
		// Left alone from now on, not retried every 15 minutes.
		await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("cascades").first())!._id, { updatedAt: 0 }));
		await t.mutation(internal.cascade.resume);
		expect((await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f) => f.state.kind === "pending")).toEqual([]);
		await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
		await expect(member.mutation(api.workspace.ensure)).rejects.toThrow("still being cleaned up");

		// Once the cause is fixed, retry picks it up where it was.
		await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("cascades").first())!._id, { cursor: null }));
		await t.mutation(internal.cascade.retry, { id: (await job())._id });
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("cascades").collect())).toEqual([]);
		await member.mutation(api.workspace.ensure);
		expect(await member.query(api.workspace.me)).toMatchObject({ role: "member" });
	});
});
