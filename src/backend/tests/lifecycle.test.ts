import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import { type Edge, type Lifecycle, edgesOf, lifecycle } from "../convex/lifecycle";
import schema from "../convex/schema";
import { modules, settle, signIn, workspaceOf } from "./helpers";
import { person } from "./person";

afterEach(() => void vi.useRealTimers());

const tables = Object.keys(schema.tables) as TableNames[];
const indexesOf = (table: TableNames) =>
	new Map((schema.tables[table] as unknown as { " indexes"(): { indexDescriptor: string; fields: string[] }[] })[" indexes"]().map((i) => [i.indexDescriptor, i.fields]));
const scopes = ["workspace", "member", "user", "connectorInstall", "automationInstall"] as const;

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
				if (edge === "root") {
					expect(table).toBe("workspaces");
					continue;
				}
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
		const now = Date.now();
		const config = { name: "Helper", description: "", instructions: "Help.", model: "anthropic/claude-haiku-5.5", tools: [] };
		const agentId = await ctx.db.insert("agents", { workspaceId, ...config, archived: false, version: 1, updatedAt: now, updatedBy: memberId });
		await ctx.db.insert("agentVersions", { agentId, version: 1, config, savedBy: memberId });
		await ctx.db.insert("invites", { workspaceId, email: "next@co.com", role: "member", invitedBy: ownerId });
		await ctx.db.insert("inviteEmails", { workspaceId, email: "next@co.com" });
		const memory = { workspaceId, agentId, content: "Note", updatedAt: now, version: 1 };
		await ctx.db.insert("memories", { ...memory, scope: "workspace", ownerId: null, updatedBy: memberId });
		await ctx.db.insert("memories", { ...memory, scope: "personal", ownerId, updatedBy: ownerId });
		mine.push(await ctx.db.insert("memories", { ...memory, scope: "personal", ownerId: memberId, updatedBy: memberId }));

		const connectorInstallId = await ctx.db.insert("connectorInstalls", { workspaceId, connectorId: "notes", roles: ["owner", "member"], installedBy: ownerId });
		const connection = { workspaceId, connectorId: "notes", credentials: "sealed" };
		mine.push(await ctx.db.insert("connectorConnections", { ...connection, userId: memberId, connectedBy: memberId }));
		await ctx.db.insert("connectorConnections", { ...connection, userId: ownerId, connectedBy: ownerId });
		await ctx.db.insert("connectorConnections", { ...connection, connectorId: "crm", userId: null, connectedBy: memberId });
		await ctx.db.insert("connectorTools", { workspaceId, connectorId: "notes", tools: [] });
		await ctx.db.insert("connectorOAuthFlows", { state: `s-${workspaceId}`, connectorId: "notes", userId: memberId, workspaceId, data: "sealed", expiresAt: now + 60_000 });
		await ctx.db.insert("pluginInstalls", { workspaceId, pluginId: "notes", roles: ["owner"], installedBy: ownerId });
		await ctx.db.insert("pluginConnections", { workspaceId, pluginId: "notes", userId: null, credentials: "sealed", connectedBy: ownerId });
		await ctx.db.insert("pluginOAuthFlows", { state: `p-${workspaceId}`, pluginId: "notes", userId: memberId, data: "sealed", expiresAt: now });
		const made = { version: 1, updatedBy: memberId, updatedAt: now };
		await ctx.db.insert("skillInstalls", { workspaceId, skillId: "custom-skill", custom: { name: "Skill", createdBy: memberId, description: "d", instructions: "i", ...made } });

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
		// More reactions than one cascade run deletes, so a message's children span runs.
		for (let i = 0; i < 150; i++) await ctx.db.insert("reactions", { messageId: said, chatId: channel, emoji: `e${i}`, userId: memberId });

		const turn = { workspaceId, chatId: channel, agentId, triggerId: said, actorId: memberId };
		const turnId = await ctx.db.insert("agentTurns", { ...turn, replyId: said, status: "done" });
		const sessionId = await ctx.db.insert("agentSessions", { workspaceId, agentId, chatId: channel });
		await ctx.db.patch(turnId, { sessionId });
		const call = { workspaceId, agentId, actorId: memberId, chatId: channel, turnId, replyId: said, callId: "c1", tool: "crm.sms", input: "{}" };
		await ctx.db.insert("agentActivity", { ...call, changes: true, status: "done" });
		await ctx.db.insert("approvals", { ...call, hash: "h", status: "pending", expiresAt: now + 60_000 });

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
		const fieldId = await ctx.db.insert("recordFields", { workspaceId, typeId, key: "name", label: "Name", kind: "text", position: 0, archived: false, createdBy: memberId, updatedAt: now });
		const recordId = await ctx.db.insert("records", { workspaceId, typeId, title: "Roof", values: { name: "Roof" }, searchText: "roof", archived: false, createdBy: memberId, updatedAt: now, updatedBy: memberId });
		await ctx.db.insert("recordValues", { recordId, fieldId, str: "roof", at: now });
		await ctx.db.insert("recordHistory", { workspaceId, typeId, recordId, action: "created", changes: [], userId: memberId });
		await ctx.db.insert("recordMentions", { recordId, messageId: said, chatId: channel });
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
	const t = convexTest({ schema, modules, transactionLimits: true });
	const a = await signIn(t, "a@co.com");
	const b = await signIn(t, "b@co.com");
	const [A, B] = [(await a.query(api.workspace.me))!.workspaceId!, (await b.query(api.workspace.me))!.workspaceId!];
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
	return !rules.workspace && !rules.childOf;
};

function diff(before: Awaited<ReturnType<typeof dump>>, after: Awaited<ReturnType<typeof dump>>) {
	const deleted = [...before.keys()].filter((id) => !after.has(id));
	const changed = [...after.keys()].filter((id) => before.has(id) && JSON.stringify(before.get(id)!.row) !== JSON.stringify(after.get(id)!.row));
	return { deleted: new Set(deleted), changed: new Set(changed) };
}

describe("deleting a workspace", () => {
	it("ends access at once, then deletes everything of it and nothing of anyone else's", { timeout: 60_000 }, async () => {
		const { t, a, b, m, A, B } = await world();
		// Every table has rows, so a cascade that missed one would show.
		const before = await dump(t);
		const seeded = new Set([...before.values()].map((r) => r.table));
		expect(tables.filter((table) => !seeded.has(table) && table !== "cascades")).toEqual([]);

		await expect(a.mutation(api.workspace.deleteWorkspace, { name: "Nope" })).rejects.toThrow("Type the workspace's name");
		await expect(m.in(A).mutation(api.workspace.deleteWorkspace, { name: "My company" })).rejects.toThrow("permission");
		await a.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		// Before any cleanup has run: nobody's in it, it's off everyone's list, and its invites can't be used.
		expect(await m.in(A).query(api.workspace.me)).toMatchObject({ workspaceId: null, role: null });
		await expect(m.in(A).mutation(api.chats.createChannel, { name: "x", private: false })).rejects.toThrow();
		expect((await m.query(api.workspace.mine))!.workspaces.map((w) => w.id)).toEqual([B]);
		expect((await a.query(api.workspace.mine))!.workspaces).toEqual([]);

		await settle(t);
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
		// In no workspace now, they start a fresh one, as on first sign-in.
		await a.mutation(api.workspace.ensure);
		const fresh = (await a.query(api.workspace.mine))!.workspaces.map((w) => w.id);
		expect(fresh).toHaveLength(1);
		expect(fresh).not.toContain(A);
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
			await ctx.db.insert("members", { workspaceId, userId: m.userId, role: "owner" });
			return workspaceId;
		});
		await seed(t, solo, m.userId, m.userId);
		const before = await dump(t);
		const sessions = new Set([...before.values()].filter((r) => r.table === "authSessions" && r.row.userId === m.userId).map((r) => r.row._id));

		await m.mutation(api.workspace.eraseAccount);
		// At once: in no workspace, and their email can't sign back in to this account.
		expect((await m.query(api.workspace.mine))!.workspaces).toEqual([]);
		await expect(m.mutation(api.workspace.ensure)).rejects.toThrow("erased");
		await settle(t);
		const after = await dump(t);
		const { deleted, changed } = diff(before, after);

		const theirs = new Set<string>([...mineIn[A]!, ...mineIn[B]!, ...seatsIn(before, A, m.userId), ...seatsIn(before, B, m.userId)]);
		for (const [id, { table, row }] of before) {
			const own = row.userId === m.userId && ["members", "preferences", "legacyWorkspaces", "authAccounts", "authSessions", "connectorOAuthFlows"].includes(table);
			const child = (table === "authVerificationCodes" && !after.has(row.accountId as string)) || (table === "authRefreshTokens" && sessions.has(row.sessionId as string));
			if (own || child) theirs.add(id);
		}
		for (const id of rowsOf(before, solo)) if (!keptWhenWorkspaceGoes(before.get(id)!.table)) theirs.add(id);
		expect([...deleted].sort()).toEqual([...theirs].sort());
		// Only the account row changed: it's still there for history, with nothing that names them.
		expect([...changed]).toEqual([m.userId]);
		expect(after.get(m.userId)!.row).toEqual({ _id: m.userId, _creationTime: before.get(m.userId)!.row._creationTime });
		expect((await a.query(api.workspace.team))!.members.map((x) => x.email)).toEqual(["a@co.com"]);
	});

	it("refuses while they're the only owner of a workspace with other people", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const owner = await signIn(t, "a@co.com");
		await owner.mutation(api.workspace.invite, { email: "m@co.com", role: "member" });
		await signIn(t, "m@co.com");
		await expect(owner.mutation(api.workspace.eraseAccount)).rejects.toThrow("only owner of My company");
		expect(await owner.query(api.workspace.me)).toMatchObject({ role: "owner" });
	});

	it("shows what they wrote as a former member's", async () => {
		const t = convexTest({ schema, modules, transactionLimits: true });
		const owner = await signIn(t, "a@co.com");
		await owner.mutation(api.workspace.invite, { email: "m@co.com", role: "member" });
		const m = await signIn(t, "m@co.com");
		const general = (await m.query(api.chats.list))!.channels[0]!._id;
		await m.mutation(api.messages.send, { chatId: general, text: "Bye", mentions: { userIds: [], agentIds: [] } });
		await m.mutation(api.workspace.eraseAccount);
		await settle(t);
		const [message] = await owner.query(api.messages.list, { chatId: general });
		expect(message).toMatchObject({ text: "Bye", author: { type: "user", name: "Former member" } });
		// A later sign-in with the same email is someone new, in none of the old workspaces.
		const again = person(t.withIdentity({ subject: `${await t.run((ctx) => ctx.db.insert("users", { email: "m@co.com" }))}|session` }));
		await again.mutation(api.workspace.ensure);
		expect((await again.query(api.workspace.mine))!.workspaces.map((w) => w.id)).not.toContain(await workspaceOf(owner));
	});
});
