import { Transform } from "@tiptap/pm/transform";
import migrationsTest from "@convex-dev/migrations/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { pageSchema } from "../convex/pageOps";
import { wake } from "../convex/wakeups";
import { type As, agentsOf, finishQuiet, identityOf, ownerAndMember, sideWorkspace, signIn } from "./helpers";

// Who can access each channel, database and page (placeAccess.ts): every read path and agent tool
// follows the list, and refusals name the roles that have access.

type Person = As & { userId: Id<"users"> };
afterEach(() => void vi.useRealTimers());

/** Owner; Crew (the member, Member role only); Office (Member and Office). Deals has a deal linked from a call. */
async function setup() {
	const { t, owner, member: crew } = await ownerAndMember();
	await owner.mutation(api.workspace.invite, { email: "office@co.com", role: "member" });
	const office = await signIn(t, "office@co.com");
	const roles = async () => (await owner.query(api.roles.list))!;
	const roleId = async (name: string) => (await roles()).find((r) => r.name === name)!.id;
	const officeRole = await owner.mutation(api.roles.create, { name: "Office" });
	const membership = async (as: Person) => (await owner.query(api.workspace.team))!.members.find((m) => m.userId === as.userId)!;
	await owner.mutation(api.workspace.setRoles, { id: (await membership(office)).id, roles: [await roleId("Member"), officeRole] });
	const types = await owner.query(api.recordTypes.list);
	const typeOf = (key: string) => types.find((x) => x.key === key)!._id;
	const deals = typeOf("deal");
	const client = await owner.mutation(api.records.create, { typeId: typeOf("client"), values: { name: "Acme Roofing" } });
	const deal = await owner.mutation(api.records.create, { typeId: deals, values: { name: "Big roof deal", client } });
	const call = await owner.mutation(api.records.create, { typeId: typeOf("call"), values: { name: "Intro call", deal } });
	const restrict = (access: { role: string; level: "view" | "edit" }[]) => owner.mutation(api.recordTypes.setAccess, { typeId: deals, access });
	return { t, owner, crew, office, officeRole, roleId, deals, deal, call, client, restrict };
}

/** A running Companybot turn for `as` in #general, with its tools. */
async function turnFor(t: ReturnType<typeof convexTest>, as: As) {
	vi.useFakeTimers();
	const general = (await as.query(api.chats.list))!.channels.find((c) => c.isDefault)!;
	const companybot = (await as.query(api.agents.list)).find((a) => a.name === "Companybot")!;
	const before = await t.run((ctx) => ctx.db.query("agentTurns").collect());
	await as.mutation(api.messages.send, { chatId: general._id, text: "@Companybot", mentions: { userIds: [], agentIds: [companybot._id] } });
	const turnId = (await t.run((ctx) => ctx.db.query("agentTurns").collect())).find((x) => !before.some((b) => b._id === x._id))!._id;
	const any = <T,>(p: Promise<T>) => p as Promise<T & { error?: string } & Record<string, unknown>>;
	return {
		turnId,
		types: () => t.mutation(internal.recordTools.typesFor, { turnId }),
		find: (input: object) => any(t.mutation(internal.recordTools.findFor, { turnId, input: { numItems: 20, ...input } })),
		get: (id: string) => any(t.mutation(internal.recordTools.getFor, { turnId, id })),
		save: (input: object) => any(t.mutation(internal.recordTools.saveFor, { turnId, input })),
		readChat: (chat: string) => any(t.mutation(internal.chatTools.readFor, { turnId, chat })),
		readPage: (page: string) => any(t.mutation(internal.pageTools.readFor, { turnId, page })),
		findPages: () => t.mutation(internal.pageTools.findFor, { turnId, input: {} }),
		saveDatabase: (input: object) => any(t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input })),
		manage: (tool: string, request: object) => any(t.mutation(internal.manageTools.runFor, { turnId, tool, input: { request } })),
		automations: () => t.mutation(internal.automationTools.listFor, { turnId }),
		followups: () => any(t.mutation(internal.wakeups.listFor, { turnId })),
		searchChat: (query: string) => any(t.mutation(internal.chatTools.searchFor, { turnId, query })),
		history: () => any(t.mutation(internal.recordTools.historyFor, { turnId })),
		views: (type: string) => any(t.mutation(internal.recordTools.viewsFor, { turnId, type })),
	};
}

describe("who can access a database", () => {
	it("keeps a restricted database from Crew everywhere: lists, get, search, links, Activity, Archive and agent tools", async () => {
		const { t, owner, crew, office, officeRole, deals, deal, call, restrict } = await setup();
		await restrict([{ role: officeRole, level: "edit" }]);

		expect((await crew.query(api.recordTypes.list)).map((x) => x.key)).not.toContain("deal");
		expect((await crew.query(api.records.list, { typeId: deals, paginationOpts: { numItems: 10, cursor: null } })).page).toEqual([]);
		expect(await crew.query(api.records.get, { recordId: deal })).toBeNull();
		expect((await crew.query(api.records.search, { query: "Big roof" })).map((r) => r._id)).not.toContain(deal);
		expect((await office.query(api.records.search, { query: "Big roof" })).map((r) => r._id)).toContain(deal);
		expect((await crew.query(api.records.history, { recordId: deal, paginationOpts: { numItems: 10, cursor: null } })).page).toEqual([]);
		// The call links to the deal: a locked chip, no name.
		const seen = (await crew.query(api.records.get, { recordId: call }))!;
		expect(seen.refs[deal]).toEqual({ name: "", locked: true });
		expect(await crew.query(api.records.refs, { ids: [deal] })).toEqual({ [deal]: { name: "", locked: true } });
		const activity = (await crew.query(api.records.activity, { paginationOpts: { numItems: 20, cursor: null } })).page;
		expect(activity.some((e) => e.recordId === deal)).toBe(false);
		await owner.mutation(api.trash.move, { kind: "record", id: deal });
		expect((await crew.query(api.trash.list, { paginationOpts: { numItems: 20, cursor: null } })).page.map((e) => e.itemId)).not.toContain(deal);
		expect((await office.query(api.trash.list, { paginationOpts: { numItems: 20, cursor: null } })).page.map((e) => e.itemId)).toContain(deal);
		await owner.mutation(api.trash.restore, { kind: "record", id: deal });

		// Office and the owner see it all.
		expect((await office.query(api.recordTypes.list)).map((x) => x.key)).toContain("deal");
		expect((await office.query(api.records.get, { recordId: call }))!.refs[deal]).toEqual({ name: "Big roof deal" });

		// Agents act with the asker's access, and say who can.
		const tools = await turnFor(t, crew);
		expect((await tools.types()).types.map((x) => x.type)).not.toContain("deal");
		expect((await tools.types()).types.find((x) => x.type === "call")!.fields.find((f) => f.key === "deal")!.linksTo).toBe("(a database you can't see)");
		expect((await tools.find({ type: "Deals" })).error).toBe("Only Office and Owners can see Deals.");
		expect((await tools.get(deal)).error).toBe("Only Office and Owners can see this database.");
		expect(((await tools.find({ search: "Big roof" })).rows as { _id: string }[]).map((r) => r._id)).not.toContain(deal);
		expect((await tools.get(call)).values).toMatchObject({ deal: "Locked record" });
		expect((await tools.save({ type: "Deals", values: { name: "Sneaky" } })).error).toBe("Only Office and Owners can see Deals.");
	});

	it("lets View read but not change, and Edit change", async () => {
		const { crew, office, officeRole, deals, deal, restrict } = await setup();
		await restrict([{ role: "everyone", level: "view" }, { role: officeRole, level: "edit" }]);
		const seen = (await crew.query(api.records.get, { recordId: deal }))!;
		expect(seen).toMatchObject({ title: "Big roof deal", canEdit: false });
		expect((await crew.query(api.recordTypes.list)).find((x) => x._id === deals)).toMatchObject({ canEdit: false, canManage: false, lock: { who: "Office and Owners", edit: true } });
		await expect(crew.mutation(api.records.update, { recordId: deal, values: { name: "Mine" } })).rejects.toThrow("Only Office and Owners can change Deals.");
		await expect(crew.mutation(api.records.create, { typeId: deals, values: { name: "New" } })).rejects.toThrow("Only Office and Owners can change Deals.");
		await expect(crew.mutation(api.fields.create, { typeId: deals, label: "Notes", kind: "text" })).rejects.toThrow("Only Office and Owners can change Deals.");
		await expect(crew.mutation(api.recordTypes.setAccess, { typeId: deals, access: [{ role: "everyone", level: "edit" }] })).rejects.toThrow("Only Office and Owners can change Deals.");
		await office.mutation(api.records.update, { recordId: deal, values: { name: "Bigger roof deal" } });
		expect((await crew.query(api.records.get, { recordId: deal }))!.title).toBe("Bigger roof deal");
	});

	it("always lets owners in, even on an Owners-only list", async () => {
		const { owner, office, deals, deal, restrict } = await setup();
		await restrict([]);
		expect(await office.query(api.records.get, { recordId: deal })).toBeNull();
		expect((await owner.query(api.records.get, { recordId: deal }))!.canEdit).toBe(true);
		await owner.mutation(api.records.update, { recordId: deal, values: { name: "Owners only" } });
		expect((await owner.query(api.recordTypes.list)).find((x) => x._id === deals)!.lock).toEqual({ who: "Owners", edit: false });
	});

	it("takes role ids from this workspace only, and drops a deleted role from every list", async () => {
		const { t, owner, office, officeRole, deals, deal, restrict } = await setup();
		const side = await sideWorkspace(t, "owner@co.com");
		const foreign = await t.run((ctx) => ctx.db.insert("roles", { workspaceId: side.workspaceId, name: "Elsewhere", switches: [] }));
		await expect(restrict([{ role: foreign, level: "edit" }])).rejects.toThrow("Role not found.");
		await expect(restrict([{ role: "nonsense", level: "edit" }])).rejects.toThrow("Role not found.");
		await restrict([{ role: officeRole, level: "edit" }]);
		expect((await office.query(api.records.get, { recordId: deal }))!.title).toBe("Big roof deal");
		await owner.mutation(api.roles.remove, { id: officeRole });
		expect(await t.run(async (ctx) => (await ctx.db.get(deals))!.access)).toEqual([]);
		expect(await office.query(api.records.get, { recordId: deal })).toBeNull();
	});
});

describe("who can access a channel", () => {
	it("makes a read-only channel: everyone reads, only Office posts or reacts", async () => {
		const { t, owner, crew, office, officeRole } = await setup();
		const news = await owner.mutation(api.chats.createChannel, { name: "news", private: false });
		await owner.mutation(api.chats.setAccess, { chatId: news, access: [{ role: "everyone", level: "view" }, { role: officeRole, level: "edit" }] });
		const posted = await office.mutation(api.messages.send, { chatId: news, text: "Big news", mentions: { userIds: [], agentIds: [] } });
		await expect(crew.mutation(api.messages.send, { chatId: news, text: "Me too", mentions: { userIds: [], agentIds: [] } })).rejects.toThrow("Only Office and Owners can post in #news.");
		await expect(crew.mutation(api.messages.react, { messageId: posted, emoji: "👍" })).rejects.toThrow("Only Office and Owners can post in #news.");
		expect((await crew.query(api.messages.list, { chatId: news })).map((m) => m.text)).toEqual(["Big news"]);
		expect(await crew.query(api.chats.get, { chatId: news })).toMatchObject({ canPost: false, canManage: false, lock: { who: "Office and Owners", edit: true } });
		expect((await office.query(api.chats.get, { chatId: news }))!.canPost).toBe(true);
		// #general stays open to everyone, at least to read.
		const general = (await owner.query(api.chats.list))!.channels.find((c) => c.isDefault)!._id;
		await expect(owner.mutation(api.chats.setAccess, { chatId: general, access: [{ role: officeRole, level: "edit" }] })).rejects.toThrow("everyone keeps at least View");
		void t;
	});

	it("hides a restricted channel from lists, browse, search, alerts and agents, naming who can see it", async () => {
		const { t, owner, crew, office, officeRole } = await setup();
		const deals = await owner.mutation(api.chats.createChannel, { name: "deals", private: false });
		await owner.mutation(api.chats.join, { chatId: deals });
		await crew.mutation(api.chats.join, { chatId: deals });
		await owner.mutation(api.messages.send, { chatId: deals, text: "Secret margin talk", mentions: { userIds: [crew.userId], agentIds: [] } });
		await owner.mutation(api.chats.setAccess, { chatId: deals, access: [{ role: officeRole, level: "edit" }] });
		expect((await crew.query(api.chats.list))!.channels.map((c) => c.name)).not.toContain("deals");
		expect((await crew.query(api.chats.browse)).map((c) => c.name)).not.toContain("deals");
		expect(await crew.query(api.chats.get, { chatId: deals })).toBeNull();
		expect(await crew.query(api.messages.list, { chatId: deals })).toEqual([]);
		expect((await crew.query(api.chats.alerts))!.some((a) => a.chatId === deals)).toBe(false);
		await expect(crew.mutation(api.messages.send, { chatId: deals, text: "hi", mentions: { userIds: [], agentIds: [] } })).rejects.toThrow("Only Office and Owners can see this channel.");
		expect((await office.query(api.chats.browse)).map((c) => c.name)).toContain("deals");
		expect((await owner.query(api.chats.list))!.channels.find((c) => c.name === "deals")!.lock).toEqual({ who: "Office and Owners", edit: false });
		const tools = await turnFor(t, crew);
		expect((await tools.readChat("#deals")).error).toBe("Only Office and Owners can see #deals.");
	});
});

describe("who can access a page", () => {
	it("passes a page's list to sub-pages that set none, and lets one set its own", async () => {
		const { t, owner, crew, office, officeRole } = await setup();
		const parent = await owner.mutation(api.pages.create, { title: "Pricing" });
		const child = await owner.mutation(api.pages.create, { title: "Margins", parentId: parent });
		await owner.mutation(api.pages.setAccess, { pageId: parent, access: [{ role: officeRole, level: "edit" }] });
		expect(await crew.query(api.pages.get, { pageId: child })).toBeNull();
		expect((await crew.query(api.pages.list)).map((p) => p.title)).not.toContain("Margins");
		expect(await crew.query(api.pages.search, { query: "Margins" })).toEqual([]);
		expect((await office.query(api.pages.get, { pageId: child }))!.canEdit).toBe(true);
		expect((await owner.query(api.pages.list)).find((p) => p._id === parent)!.lock).toEqual({ who: "Office and Owners", edit: false });

		// Its own list wins: everyone may read the child, only Office may edit it.
		await owner.mutation(api.pages.setAccess, { pageId: child, access: [{ role: "everyone", level: "view" }, { role: officeRole, level: "edit" }] });
		expect(await crew.query(api.pages.get, { pageId: child })).toMatchObject({ title: "Margins", canEdit: false, canManageAccess: false, ancestors: [] });
		await expect(crew.mutation(api.pages.rename, { pageId: child, title: "Mine" })).rejects.toThrow("Only Office and Owners can edit Margins.");
		const tools = await turnFor(t, crew);
		expect((await tools.readPage("Margins")).title).toBe("Margins");
		expect((await tools.readPage("Pricing")).error).toBe("Only Office and Owners can see Pricing.");
		expect((await tools.findPages()).rows.map((r) => r.title)).not.toContain("Pricing");

		// Back to following its parent.
		await owner.mutation(api.pages.setAccess, { pageId: child, access: null });
		expect(await crew.query(api.pages.get, { pageId: child })).toBeNull();
	});

	it("never opens a page to more people by moving it", async () => {
		const { owner, crew, officeRole } = await setup();
		const parent = await owner.mutation(api.pages.create, { title: "Office" });
		const child = await owner.mutation(api.pages.create, { title: "Payroll", parentId: parent });
		await owner.mutation(api.pages.setAccess, { pageId: parent, access: [{ role: officeRole, level: "edit" }] });
		await owner.mutation(api.pages.move, { pageId: child });
		expect(await crew.query(api.pages.get, { pageId: child })).toBeNull();
		// Moving an open page under a restricted one makes it follow that one.
		const notes = await owner.mutation(api.pages.create, { title: "Notes" });
		await owner.mutation(api.pages.move, { pageId: notes, parentId: parent });
		expect(await crew.query(api.pages.get, { pageId: notes })).toBeNull();
	});

	it("makes a record's page follow its database", async () => {
		const { crew, office, officeRole, deal, restrict, owner } = await setup();
		const page = await owner.mutation(api.pages.create, { recordId: deal });
		await restrict([{ role: "everyone", level: "view" }, { role: officeRole, level: "edit" }]);
		expect((await crew.query(api.pages.get, { pageId: page }))!.canEdit).toBe(false);
		expect((await office.query(api.pages.get, { pageId: page }))!.canEdit).toBe(true);
		await expect(owner.mutation(api.pages.setAccess, { pageId: page, access: [] })).rejects.toThrow("follows its database");
		await restrict([{ role: officeRole, level: "edit" }]);
		expect(await crew.query(api.pages.get, { pageId: page })).toBeNull();
		expect(await crew.query(api.pages.forRecord, { recordId: deal })).toBeNull();
	});
});

type T = ReturnType<typeof convexTest>;
const PAGE = { paginationOpts: { numItems: 50, cursor: null } };
const generalOf = async (as: As) => (await as.query(api.chats.list))!.channels.find((c) => c.isDefault)!._id;
const turnOfWake = async (t: T, id: Id<"wakeups">) => (await t.run((ctx) => ctx.db.query("agentTurns").collect())).find((x) => x.wakeupId === id);

/** A follow-up of Companybot's for `as` in `chatId`, woken at once (wakeups.wake, as the scheduler would). */
async function wakeIn(t: T, as: Person, chatId: Id<"chats">, extra: { recordId?: Id<"records">; typeId?: Id<"recordTypes"> } = {}) {
	vi.useFakeTimers();
	const { companybot } = await agentsOf(as);
	return t.run(async (ctx) => {
		const chat = (await ctx.db.get(chatId))!;
		const id = await ctx.db.insert("wakeups", { workspaceId: chat.workspaceId, agentId: companybot._id, chatId, actorId: as.userId, createdBy: as.userId, note: "Check in", foreign: false, status: "pending", jobId: "j", ...extra });
		await wake(ctx, id);
		return id;
	});
}

// Each of these was a way around the list, found in review. Each test keeps one closed.
describe("restored, woken, queued and background paths", () => {
	it("keeps a restored page's list when its parent stays in Archive", async () => {
		const { owner, crew, office, officeRole } = await setup();
		const parent = await owner.mutation(api.pages.create, { title: "Office only" });
		const child = await owner.mutation(api.pages.create, { title: "Budget", parentId: parent });
		await owner.mutation(api.pages.setAccess, { pageId: parent, access: [{ role: officeRole, level: "edit" }] });
		await owner.mutation(api.trash.move, { kind: "page", id: child });
		await owner.mutation(api.trash.move, { kind: "page", id: parent });
		await owner.mutation(api.trash.restore, { kind: "page", id: child });
		expect(await owner.query(api.pages.get, { pageId: child })).toMatchObject({ archived: false, parentId: null, ownAccess: [{ role: officeRole, level: "edit" }] });
		expect(await crew.query(api.pages.get, { pageId: child })).toBeNull();
		expect((await office.query(api.pages.get, { pageId: child }))!.title).toBe("Budget");
	});

	it("never wakes or replies for someone who can only view: checked when it starts, on each step and before it's shown", async () => {
		const { t, owner, crew, officeRole } = await setup();
		const general = await generalOf(owner);
		// Both set while they could post: the first runs, the second waits behind it.
		const first = await wakeIn(t, crew, general);
		const second = await wakeIn(t, crew, general);
		const running = (await turnOfWake(t, first))!;
		expect(running.status).toBe("running");
		expect((await turnOfWake(t, second))!.status).toBe("queued");
		await owner.mutation(api.chats.setAccess, { chatId: general, access: [{ role: "everyone", level: "view" }, { role: officeRole, level: "edit" }] });
		await expect(t.mutation(internal.turns.turnContext, { turnId: running._id })).rejects.toThrow("This person can no longer post in this chat.");
		await finishQuiet(t, running._id, "Posting anyway");
		expect((await crew.query(api.messages.list, { chatId: general })).map((m) => m.text)).not.toContain("Posting anyway");
		expect((await turnOfWake(t, second))!.status).toBe("error");
		// A new one stops before any turn.
		const third = await wakeIn(t, crew, general);
		expect(await t.run((ctx) => ctx.db.get(third))).toMatchObject({ status: "cancelled", reason: "Its person can no longer post in the chat." });
		expect(await turnOfWake(t, third)).toBeUndefined();
	});

	it("stops an ordinary reply mid-stream when its person loses Post, and posts nothing it writes after", async () => {
		const { t, owner, crew, officeRole } = await setup();
		const general = await generalOf(owner);
		const turnId: Id<"agentTurns"> = (await turnFor(t, crew)).turnId;
		const write = (text: string) => t.mutation(internal.turns.updateReply, { turnId, text, parts: [{ type: "text", text }] });
		expect(await write("Before the change")).toEqual({ stopped: false, steer: false });
		await owner.mutation(api.chats.setAccess, { chatId: general, access: [{ role: "everyone", level: "view" }, { role: officeRole, level: "edit" }] });
		// The runner's checks all see it, and nothing more is written.
		expect(await write("After the change")).toEqual({ stopped: true, steer: false });
		expect(await t.query(internal.turns.isStopping, { turnId })).toEqual({ stopped: true, steer: false });
		expect((await t.query(internal.turns.steerWait, { turnId })).stopped).toBe(true);
		await t.mutation(internal.turns.finishReply, { turnId });
		const turn = (await t.run((ctx) => ctx.db.get(turnId)))!;
		const reply = (await t.run((ctx) => ctx.db.get(turn.replyId!)))!;
		expect(turn.status).toBe("error");
		expect(reply).toMatchObject({ status: "error", error: "This person can no longer post in this chat." });
		expect(JSON.stringify(reply)).not.toContain("After the change");
		expect(JSON.stringify(await crew.query(api.messages.list, { chatId: general }))).not.toContain("After the change");
	});

	it("cancels a follow-up whose record's database was hidden since, without naming it in Activity", async () => {
		const { t, owner, crew, officeRole, deals, deal, restrict } = await setup();
		await restrict([{ role: officeRole, level: "edit" }]);
		const id = await wakeIn(t, crew, await generalOf(owner), { recordId: deal, typeId: deals });
		expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "cancelled", reason: "Its person can no longer see this record." });
		// The line shows to everyone in the chat, Crew included.
		const lines = JSON.stringify(await owner.query(api.activity.list, {}));
		expect(lines).toContain("Its person can no longer see this record.");
		expect(lines).not.toMatch(/Deals/);
	});

	it("stops a queued wake from reading a record whose database was hidden since", async () => {
		const { t, owner, crew, officeRole, deals, deal, restrict } = await setup();
		const id = await wakeIn(t, crew, await generalOf(owner), { recordId: deal, typeId: deals });
		const turn = (await turnOfWake(t, id))!;
		expect((await t.mutation(internal.turns.turnContext, { turnId: turn._id })).wake).toMatchObject({ record: { id: deal, name: "Big roof deal" } });
		await restrict([{ role: officeRole, level: "edit" }]);
		await expect(t.mutation(internal.turns.turnContext, { turnId: turn._id })).rejects.toThrow("Only Office and Owners can see this database.");
		expect(await t.mutation(internal.recordTools.getFor, { turnId: turn._id, id: deal })).toEqual({ error: "Only Office and Owners can see this database." });
	});

	it("stores no sub-page's title in its parent: sync, history, a restore and agents name a hidden one to nobody", async () => {
		const { t, owner, crew, office, officeRole } = await setup();
		migrationsTest.register(t);
		vi.useFakeTimers();
		const handbook = await owner.mutation(api.pages.create, { title: "Handbook" });
		const salaries = await owner.mutation(api.pages.create, { title: "Salaries", parentId: handbook });
		await owner.mutation(api.pages.setAccess, { pageId: salaries, access: [{ role: officeRole, level: "edit" }] });
		vi.advanceTimersByTime(15 * 60_000);
		// What an older app stored: the block's title, in a step, in a snapshot and so in a version.
		const lib = components.prosemirrorSync.lib;
		const legacy = await t.run(async (ctx) => {
			const at = (await ctx.runQuery(lib.latestVersion, { id: handbook }))!;
			const json = JSON.parse((await ctx.runQuery(lib.getSnapshot, { id: handbook })).content!);
			let pos = -1;
			pageSchema().nodeFromJSON(json).descendants((node, p) => void (node.type.name === "page" && (pos = p)));
			const tag = (x: unknown): void => {
				if (Array.isArray(x)) return x.forEach(tag);
				if (!x || typeof x !== "object") return;
				const o = x as { type?: string; attrs?: Record<string, unknown> };
				if (o.type === "page") o.attrs!.title = "Salaries";
				Object.values(o).forEach(tag);
			};
			tag(json);
			await ctx.runMutation(lib.submitSteps, { id: handbook, version: at, clientId: "old app", steps: [JSON.stringify({ stepType: "attr", pos, attr: "title", value: "Salaries" })] });
			await ctx.runMutation(lib.submitSnapshot, { id: handbook, version: at + 1, content: JSON.stringify(json) });
			const last = (await ctx.db.query("pageVersions").withIndex("by_page", (q) => q.eq("pageId", handbook)).order("desc").first())!;
			const versionId = await ctx.db.insert("pageVersions", { pageId: handbook, n: last.n + 1, version: at + 1, userId: last.userId, editedAt: Date.now() });
			return { at, versionId };
		});
		expect(JSON.stringify(await t.run((ctx) => ctx.runQuery(lib.getSteps, { id: handbook, version: 1 })))).toMatch(/Salaries/);
		// The editor's own reads, as Crew: the latest document, an older one and every step.
		const sync = identityOf(t, crew.userId);
		for (const version of [undefined, legacy.at, legacy.at + 1]) {
			const doc = await sync.query(api.pageSync.getSnapshot, { id: handbook, version });
			expect(doc.content).toContain(salaries);
			expect(doc.content).not.toMatch(/Salaries/);
		}
		const steps = await sync.query(api.pageSync.getSteps, { id: handbook, version: 1 });
		expect(steps.steps.length).toBeGreaterThan(1);
		expect(JSON.stringify(steps)).not.toMatch(/Salaries/);
		// History and agents, as Crew; and since no block holds a title, Office's history has none either.
		const read = await (await turnFor(t, crew)).readPage("Handbook");
		expect(read.doc).toContain(salaries);
		expect(JSON.stringify(read)).not.toMatch(/Salaries/);
		const versions = (await crew.query(api.pages.history, { pageId: handbook, ...PAGE })).page;
		for (const v of versions) {
			expect(await crew.query(api.pages.version, { versionId: v._id })).not.toMatch(/Salaries/);
			expect(await office.query(api.pages.version, { versionId: v._id })).not.toMatch(/Salaries/);
		}
		// Crew, who can't see it, changes the page and then puts the old version back: nothing brings the title back.
		vi.advanceTimersByTime(15 * 60_000);
		await crew.mutation(api.pages.create, { title: "Notes", parentId: handbook });
		vi.advanceTimersByTime(15 * 60_000);
		await crew.mutation(api.pages.restore, { versionId: legacy.versionId });
		const latest = (await t.run((ctx) => ctx.runQuery(lib.getSnapshot, { id: handbook }))) as { content: string; version: number };
		expect(latest.version).toBeGreaterThan(legacy.at + 1);
		expect(latest.content).toContain(salaries);
		expect(latest.content).not.toMatch(/Salaries/);
		// The migration takes it out of the stored version too.
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const stored = (await t.run((ctx) => ctx.runQuery(lib.getSnapshot, { id: handbook, version: legacy.at + 1 }))) as { content: string; version: number };
		expect(stored).toMatchObject({ version: legacy.at + 1 });
		expect(stored.content).toContain(salaries);
		expect(stored.content).not.toMatch(/Salaries/);
		expect((await office.query(api.pages.get, { pageId: salaries }))!.title).toBe("Salaries");
	});

	it("keeps an old editor's title step, sanitized, so its version stays in step and its next edit lands", async () => {
		const { t, owner } = await setup();
		const handbook = await owner.mutation(api.pages.create, { title: "Handbook" });
		const child = await owner.mutation(api.pages.create, { title: "Salaries", parentId: handbook });
		const sync = identityOf(t, owner.userId);
		const at = (await sync.query(api.pageSync.latestVersion, { id: handbook }))!;
		const doc = pageSchema().nodeFromJSON(JSON.parse((await sync.query(api.pageSync.getSnapshot, { id: handbook })).content!));
		let blockAt = -1;
		let textAt = -1;
		doc.descendants((node, pos) => {
			if (node.type.name === "page") blockAt = pos;
			if (node.type.name === "paragraph" && textAt < 0) textAt = pos + 1;
		});
		// What an alpha.9 editor sends when a sub-page is renamed: a title the schema no longer has.
		const titleStep = JSON.stringify({ stepType: "attr", pos: blockAt, attr: "title", value: "Salaries" });
		expect(await sync.mutation(api.pageSync.submitSteps, { id: handbook, version: at, clientId: "old", steps: [titleStep] })).toEqual({ status: "synced" });
		expect(await sync.query(api.pageSync.latestVersion, { id: handbook })).toBe(at + 1);
		// Its next edit, from the version it now holds, lands.
		const edit = new Transform(doc).insert(textAt, doc.type.schema.text("Hello")).steps.map((step) => JSON.stringify(step.toJSON()));
		expect(await sync.mutation(api.pageSync.submitSteps, { id: handbook, version: at + 1, clientId: "old", steps: edit })).toEqual({ status: "synced" });
		const after = await sync.query(api.pageSync.getSnapshot, { id: handbook });
		expect(after.content).toContain("Hello");
		expect(after.content).toContain(child);
		// The stored step keeps no title.
		expect(JSON.stringify(await t.run((ctx) => ctx.runQuery(components.prosemirrorSync.lib.getSteps, { id: handbook, version: at })))).not.toMatch(/Salaries/);
	});

	it("drops a channel someone lost from their chat list and their workspace badges", async () => {
		const { t, owner, crew, officeRole } = await setup();
		const vault = await owner.mutation(api.chats.createChannel, { name: "vault", private: false });
		await crew.mutation(api.chats.join, { chatId: vault });
		const tools = await turnFor(t, crew);
		const names = async () => ((await tools.manage("chat.manage", { action: "list_chats" })).page as { name?: string }[]).map((c) => c.name);
		expect(await names()).toContain("vault");
		await owner.mutation(api.chats.setAccess, { chatId: vault, access: [{ role: officeRole, level: "edit" }] });
		expect(await names()).not.toContain("vault");
		const before = await crew.query(api.workspace.activity);
		await owner.mutation(api.messages.send, { chatId: vault, text: "For you", mentions: { userIds: [crew.userId], agentIds: [] } });
		expect(await crew.query(api.workspace.activity)).toEqual(before);
	});

	it("doesn't name or point at a hidden channel in automation listings or their last runs", async () => {
		const { t, owner, crew, office, officeRole } = await setup();
		const vault = await owner.mutation(api.chats.createChannel, { name: "vault", private: false });
		await owner.mutation(api.chats.setAccess, { chatId: vault, access: [{ role: officeRole, level: "edit" }] });
		const { companybot } = await agentsOf(owner);
		const make = (name: string, trigger: object, audience: "subscribers" | "channel", channelId?: Id<"chats">) =>
			owner.mutation(api.automations.create, { config: { name, prompt: "Sum it up.", trigger: trigger as never }, agentId: companybot._id, audience, channelId, timeZone: "UTC" });
		const watcher = await make("Watcher", { type: "event", event: "message.posted", channelId: vault }, "subscribers");
		const poster = await make("Poster", { type: "schedule", cron: "0 9 * * *" }, "channel", vault);
		// Last runs naming a channel: one that posted there, and one refused for watching it. Its turn never runs.
		vi.useFakeTimers();
		await t.mutation(internal.automationRuns.tick, { now: Date.now() + 2 * 86_400_000 });
		await t.run(async (ctx) => {
			const install = (await ctx.db.query("automationInstalls").collect()).find((i) => i.automationId === watcher)!;
			await ctx.db.patch(install._id, { lastRunAt: Date.now(), lastOutcome: { text: "Didn't run: It watches {watched}, which is private.", watchedId: vault } });
		});
		const seen = await crew.query(api.automations.list);
		expect(seen.find((a) => a.name === "Watcher")).toMatchObject({ trigger: "When someone posts in #a channel", channelId: null, channelName: null, lastResult: "Didn't run: It watches a channel, which is private." });
		expect(seen.find((a) => a.name === "Poster")).toMatchObject({ runsFor: "Posts once in a channel", channelId: null, channelName: null, lastResult: "Posted in a channel." });
		const tools = await turnFor(t, crew);
		const got = await tools.manage("automations.manage", { action: "get", id: poster });
		expect(JSON.stringify(got)).toContain("Posted in a channel.");
		const text = JSON.stringify([seen, got, await tools.automations(), await tools.manage("automations.manage", { action: "list" }), await tools.manage("automations.manage", { action: "get", id: watcher })]);
		expect(text).not.toMatch(/vault/);
		expect(text).not.toContain(vault);
		const theirs = await office.query(api.automations.list);
		expect(theirs.find((a) => a.name === "Poster")!.lastResult).toBe("Posted in #vault.");
		expect(theirs.find((a) => a.name === "Watcher")!.lastResult).toBe("Didn't run: It watches #vault, which is private.");
	});

	it("names neither a hidden page a sub-page moved from nor a hidden ancestor that holds it in Archive", async () => {
		const { owner, crew, officeRole } = await setup();
		const board = await owner.mutation(api.pages.create, { title: "Board" });
		await owner.mutation(api.pages.setAccess, { pageId: board, access: [{ role: officeRole, level: "edit" }] });
		const agenda = await owner.mutation(api.pages.create, { title: "Agenda", parentId: board });
		await owner.mutation(api.pages.setAccess, { pageId: agenda, access: [{ role: "everyone", level: "view" }] });
		await owner.mutation(api.pages.move, { pageId: agenda });
		const moves = async (as: As) => (await as.query(api.pages.moves, { pageId: agenda, ...PAGE })).page.map((m) => [m.from, m.to]);
		expect(await moves(crew)).toEqual([["a page you can't see", "Pages"]]);
		expect(await moves(owner)).toEqual([["Board", "Pages"]]);

		// Under it, a page everyone can see: its row in a deeper page's breadcrumbs doesn't point at Board either.
		const notes = await owner.mutation(api.pages.create, { title: "Notes", parentId: board });
		await owner.mutation(api.pages.setAccess, { pageId: notes, access: [{ role: "everyone", level: "view" }] });
		const deeper = await owner.mutation(api.pages.create, { title: "Deeper", parentId: notes });
		const crumbs = (await crew.query(api.pages.get, { pageId: deeper }))!;
		expect(crumbs.ancestors).toEqual([expect.objectContaining({ _id: notes, parentId: null })]);
		expect(JSON.stringify(crumbs)).not.toContain(board);

		const minutes = await owner.mutation(api.pages.create, { title: "Minutes", parentId: board });
		await owner.mutation(api.pages.setAccess, { pageId: minutes, access: [{ role: "everyone", level: "view" }] });
		await owner.mutation(api.trash.move, { kind: "page", id: board });
		const seen = (await crew.query(api.pages.get, { pageId: minutes }))!;
		expect(seen).toMatchObject({ archived: true, trash: null, parentId: null, ancestors: [] });
		expect(JSON.stringify(seen)).not.toMatch(/Board/);
		expect(JSON.stringify(seen)).not.toContain(board);
	});

	it("counts linked records in hidden databases against the read budget", async () => {
		const { t, crew, deal, client, officeRole, restrict } = await setup();
		await restrict([{ role: officeRole, level: "edit" }]);
		// Five near-1 MB records the crew can't see, then one they can: the budget (4 MB) runs out first.
		const hidden = await t.run(async (ctx) => {
			const { _id, _creationTime, ...row } = (await ctx.db.get(deal))!;
			const ids = [];
			for (let i = 0; i < 5; i++) ids.push(await ctx.db.insert("records", { ...row, title: `Big ${i}`, values: { ...row.values, notes: "x".repeat(900_000) } }));
			return ids;
		});
		const refs = await crew.query(api.records.refs, { ids: [...hidden, client] });
		expect(refs[client]).toBeUndefined();
		for (const id of hidden) expect(refs[id]).toEqual({ name: "", locked: true });
	});

	it("searches past hidden matches instead of stopping short, in the app and for agents, and says when there's more", async () => {
		const { t, owner, crew, officeRole, deals, client, restrict } = await setup();
		for (let i = 0; i < 12; i++) await owner.mutation(api.records.create, { typeId: deals, values: { name: `Zebra deal ${i}` } });
		const clients = (await t.run((ctx) => ctx.db.get(client)))!.typeId;
		const zebra = await owner.mutation(api.records.create, { typeId: clients, values: { name: "Zebra Co, the striped roofing company in town" } });
		await restrict([{ role: officeRole, level: "edit" }]);
		// The app's search keeps going past them to fill its results.
		expect((await crew.query(api.records.search, { query: "Zebra" })).map((r) => r._id)).toEqual([zebra]);
		const tools = await turnFor(t, crew);
		// So does an agent's: its first page has the one match it can see.
		expect(((await tools.find({ search: "Zebra", numItems: 1 })).rows as { _id: string }[]).map((r) => r._id)).toEqual([zebra]);
		const found: string[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 30; i++) {
			const page = await tools.find({ search: "Zebra", numItems: 1, ...(cursor && { cursor }) });
			found.push(...(page.rows as { _id: string }[]).map((r) => r._id));
			// Empty pages say there's more while hidden hits were skipped.
			if (!found.length) expect(page.more).toBe(true);
			if (!page.more) break;
			cursor = page.cursor as string;
		}
		expect(found).toEqual([zebra]);
	});

	// Each seeds hidden matches through the app's own mutations, then pages through them.
	const pageThrough = async (find: (cursor?: string) => Promise<{ rows?: unknown; more?: unknown; cursor?: unknown; error?: string }>) => {
		const found: string[] = [];
		let cursor: string | undefined;
		for (let calls = 1; calls <= 50; calls++) {
			const page = await find(cursor);
			expect(page.error).toBeUndefined();
			found.push(...(page.rows as { _id: string }[]).map((r) => r._id));
			if (!page.more) return { found, calls };
			cursor = page.cursor as string;
		}
		throw new Error("Never finished.");
	};

	it("keeps each search call within its read budget past many large hidden matches", { timeout: 120_000 }, async () => {
		const { t, owner, crew, officeRole } = await setup();
		const vault = await owner.mutation(api.recordTypes.create, { plural: "Dossiers" });
		const keys: string[] = [];
		for (let i = 0; i < 10; i++) keys.push((await owner.mutation(api.fields.create, { typeId: vault, label: `Part ${i}`, kind: "text" })).key);
		const long = (i: number) => Object.fromEntries(keys.map((k, j) => [k, `quokka ${i} ${j} ${"x".repeat(9_900)}`]));
		// About 110 KB each, 180 of them: rereading them all would pass the 16 MiB a query may read.
		for (let i = 0; i < 180; i++) await owner.mutation(api.records.create, { typeId: vault, values: { name: `Dossier quokka ${i}`, ...long(i) } });
		await owner.mutation(api.recordTypes.setAccess, { typeId: vault, access: [{ role: officeRole, level: "edit" }] });
		const clients = (await owner.query(api.recordTypes.list)).find((x) => x.key === "client")!._id;
		const seen = await owner.mutation(api.records.create, { typeId: clients, values: { name: "Quokka Roofing" } });
		await crew.query(api.records.search, { query: "quokka" });
		const tools = await turnFor(t, crew);
		const { found, calls } = await pageThrough((cursor) => tools.find({ search: "quokka", numItems: 20, ...(cursor && { cursor }) }));
		expect(found).toEqual([seen]);
		expect(calls).toBeGreaterThan(1);
	});

	it("never runs a search past the index's 1,024 candidates, however many hidden matches come first", { timeout: 120_000 }, async () => {
		const { t, owner, crew, officeRole, deals, restrict } = await setup();
		for (let i = 0; i < 1_100; i++) await owner.mutation(api.records.create, { typeId: deals, values: { name: `Wombat deal ${i}` } });
		await restrict([{ role: officeRole, level: "edit" }]);
		const clients = (await owner.query(api.recordTypes.list)).find((x) => x.key === "client")!._id;
		const seen = await owner.mutation(api.records.create, { typeId: clients, values: { name: "Wombat Co" } });
		// The app's search reads one budget's worth and stops; it doesn't fail.
		expect(await crew.query(api.records.search, { query: "wombat" })).toEqual([]);
		const tools = await turnFor(t, crew);
		const { found } = await pageThrough((cursor) => tools.find({ search: "wombat", numItems: 20, ...(cursor && { cursor }) }));
		expect(found).toEqual([seen]);
	});

	it("never trades a hidden place's id for its name: refusals by id are generic, field schemas don't point at it", async () => {
		const { t, owner, crew, office, officeRole, deals, call, restrict } = await setup();
		await restrict([{ role: officeRole, level: "edit" }]);
		const salaries = await owner.mutation(api.pages.create, { title: "Secret salaries" });
		await owner.mutation(api.pages.setAccess, { pageId: salaries, access: [{ role: officeRole, level: "edit" }] });
		const tools = await turnFor(t, crew);
		// By id: nothing they didn't already know. By name: only what they typed.
		expect((await tools.readPage(salaries)).error).toBe("Only Office and Owners can see this page.");
		expect((await tools.readPage("Secret salaries")).error).toBe("Only Office and Owners can see Secret salaries.");
		expect((await tools.find({ type: deals })).error).toBe("Only Office and Owners can see this database.");
		expect((await tools.find({ type: "deal" })).error).toBe("Only Office and Owners can see deal.");
		// A visible database's link field to a hidden one carries no id to ask about.
		const callFields = async (as: As) => (await as.query(api.recordTypes.list)).find((x) => x.key === "call")!.fields.find((f) => f.key === "deal")!;
		expect(await callFields(crew)).toMatchObject({ kind: "link", linksHidden: true });
		expect(await callFields(crew)).not.toHaveProperty("linkType");
		expect(JSON.stringify(await crew.query(api.recordTypes.list))).not.toContain(deals);
		const record = (await crew.query(api.records.get, { recordId: call }))!;
		expect(JSON.stringify(record.fields)).not.toContain(deals);
		expect(record.fields.find((f) => f.key === "deal")).toMatchObject({ linksHidden: true });
		expect(await callFields(office)).toMatchObject({ linkType: deals });
	});

	it("doesn't list hidden databases when a name isn't found", async () => {
		const { t, owner, crew, deals, officeRole, restrict } = await setup();
		await restrict([{ role: officeRole, level: "edit" }]);
		await owner.mutation(api.trash.move, { kind: "database", id: deals });
		const tools = await turnFor(t, crew);
		const restored = await tools.saveDatabase({ type: "Nope", trash: false });
		expect(restored.error).toMatch(/^There's no database “Nope”/);
		expect(restored.error).not.toMatch(/deal/i);
		expect((await tools.find({ type: "Nope" })).error).not.toMatch(/deal/i);
	});

	it("tells the page tree which pages each person can change", async () => {
		const { owner, crew, office, officeRole } = await setup();
		const policy = await owner.mutation(api.pages.create, { title: "Policy" });
		await owner.mutation(api.pages.setAccess, { pageId: policy, access: [{ role: "everyone", level: "view" }, { role: officeRole, level: "edit" }] });
		const row = async (as: As) => (await as.query(api.pages.children, PAGE)).page.find((p) => p._id === policy)!;
		expect((await row(crew)).canEdit).toBe(false);
		expect((await row(office)).canEdit).toBe(true);
		expect((await crew.query(api.pages.list)).find((p) => p._id === policy)!.canEdit).toBe(false);
	});
});

describe("a restricted place, as someone not on its list", () => {
	it("never shows in a listing or an agent tool, by name or id", async () => {
		const { t, owner, crew, office: officeMember, officeRole } = await setup();
		// Agent turns start here but never run: no model calls.
		vi.useFakeTimers();
		const office = [{ role: officeRole, level: "edit" as const }];
		// A database, a channel and a page only Office can see, each with something in it, some in Archive.
		const vaultType = await owner.mutation(api.recordTypes.create, { plural: "Vaultbids" });
		const bid = await owner.mutation(api.records.create, { typeId: vaultType, values: { name: "Vaultbid quartz" } });
		const old = await owner.mutation(api.records.create, { typeId: vaultType, values: { name: "Vaultbid old quartz" } });
		await owner.mutation(api.trash.move, { kind: "record", id: old });
		await owner.mutation(api.recordTypes.setAccess, { typeId: vaultType, access: office });
		const room = await owner.mutation(api.chats.createChannel, { name: "vaultroom", private: false });
		await crew.mutation(api.chats.join, { chatId: room });
		await owner.mutation(api.messages.send, { chatId: room, text: "Quartz plans", mentions: { userIds: [crew.userId], agentIds: [] } });
		await owner.mutation(api.chats.setAccess, { chatId: room, access: office });
		const plan = await owner.mutation(api.pages.create, { title: "Vaultplan quartz" });
		await owner.mutation(api.pages.create, { title: "Vaultplan inside", parentId: plan });
		await owner.mutation(api.pages.setAccess, { pageId: plan, access: office });
		const { companybot } = await agentsOf(owner);
		await owner.mutation(api.automations.create, { config: { name: "Digest", prompt: "Sum it up.", trigger: { type: "event", event: "message.posted", channelId: room } }, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		// More of what's in them: a saved view, links both ways, a mention of a record they can see, someone
		// typing, an agent's call, an automation's last run there, and a page they can see holding one they can't.
		const clients = (await owner.query(api.recordTypes.list)).find((x) => x.key === "client")!._id;
		const acme = await owner.mutation(api.records.create, { typeId: clients, values: { name: "Acme" } });
		const toClient = await owner.mutation(api.fields.create, { typeId: vaultType, label: "Client", kind: "link", linkTypeId: clients });
		await owner.mutation(api.records.update, { recordId: bid, values: { [toClient.key]: acme } });
		await owner.mutation(api.fields.create, { typeId: clients, label: "Bid", kind: "link", linkTypeId: vaultType });
		await owner.mutation(api.databaseViews.save, { typeId: vaultType, name: "Vaultview", filters: [], columns: ["name"], sort: { field: "name", order: "asc" } });
		await owner.mutation(api.messages.send, { chatId: room, text: "Vault talk about Acme", mentions: { userIds: [], agentIds: [], recordIds: [acme] } });
		await owner.mutation(api.messages.send, { chatId: room, text: "@Companybot vault check", mentions: { userIds: [], agentIds: [companybot._id] } });
		const ownersTurn = (await t.run((ctx) => ctx.db.query("agentTurns").collect())).find((x) => x.chatId === room)!;
		await t.mutation(internal.activity.log, { turnId: ownersTurn._id, callId: "c1", tool: "records.find", changes: false, input: JSON.stringify({ type: "Vaultbids" }), output: "Vaultbid quartz" });
		await owner.mutation(api.automations.create, { config: { name: "Poster", prompt: "Sum it up.", trigger: { type: "schedule", cron: "0 9 * * *" } }, agentId: companybot._id, audience: "channel", channelId: room, timeZone: "UTC" });
		await t.mutation(internal.automationRuns.tick, { now: Date.now() + 2 * 86_400_000 });
		expect((await owner.query(api.automations.list)).find((a) => a.name === "Poster")!.lastResult).toBe("Posted in #vaultroom.");
		await owner.mutation(api.typing.ping, { chatId: room });
		const lobby = await owner.mutation(api.pages.create, { title: "Lobby" });
		const kid = await owner.mutation(api.pages.create, { title: "Vaultplan kid", parentId: lobby });
		await owner.mutation(api.pages.setAccess, { pageId: kid, access: office });
		const sync = identityOf(t, crew.userId);
		const refused = (p: Promise<unknown>) => p.then(() => "allowed", (e: Error) => e.message);

		const tools = await turnFor(t, crew);
		const seen = {
			chats: await crew.query(api.chats.list),
			browse: await crew.query(api.chats.browse),
			alerts: await crew.query(api.chats.alerts),
			threads: await crew.query(api.chats.activeThreads, { now: Date.now() }),
			badges: await crew.query(api.workspace.activity),
			types: await crew.query(api.recordTypes.list),
			search: await crew.query(api.records.search, { query: "quartz" }),
			activity: await crew.query(api.records.activity, PAGE),
			pages: await crew.query(api.pages.list),
			pageSearch: await crew.query(api.pages.search, { query: "quartz" }),
			children: await crew.query(api.pages.children, PAGE),
			trash: await crew.query(api.trash.list, PAGE),
			automations: await crew.query(api.automations.list),
			followups: await crew.query(api.wakeups.list, {}),
			toolTypes: await tools.types(),
			toolArchivedTypes: await t.mutation(internal.recordTools.typesFor, { turnId: tools.turnId, trashed: true }),
			toolSearch: await tools.find({ search: "quartz" }),
			toolHistory: await tools.history(),
			toolPages: await tools.findPages(),
			toolChat: await tools.readChat("#general"),
			toolChatSearch: await tools.searchChat("Quartz"),
			toolChats: await tools.manage("chat.manage", { action: "list_chats" }),
			toolPeople: await tools.manage("chat.manage", { action: "find_people" }),
			toolChannels: await tools.manage("channels.manage", { action: "list" }),
			toolAutomations: await tools.automations(),
			toolAutomationList: await tools.manage("automations.manage", { action: "list" }),
			toolFollowups: await tools.followups(),
			agentActivity: await crew.query(api.activity.list, {}),
			toolAgentActivity: await t.mutation(internal.recordTools.historyFor, { turnId: tools.turnId, source: "agents" }),
			views: await crew.query(api.databaseViews.list, { typeId: vaultType }),
			toolViews: await tools.views(vaultType),
			linked: await crew.query(api.records.linked, { recordId: acme, ...PAGE }),
			acme: await crew.query(api.records.get, { recordId: acme }),
			discussion: await crew.query(api.records.discussion, { recordId: acme }),
			typing: await crew.query(api.typing.list, { chatId: room }),
			lobby: await sync.query(api.pageSync.getSnapshot, { id: lobby }),
			lobbyFirst: await sync.query(api.pageSync.getSnapshot, { id: lobby, version: 1 }),
			lobbySteps: await sync.query(api.pageSync.getSteps, { id: lobby, version: 1 }),
			planSync: await refused(sync.query(api.pageSync.getSnapshot, { id: plan })),
			planSteps: await refused(sync.query(api.pageSync.getSteps, { id: plan, version: 1 })),
			lobbyHistory: await Promise.all((await crew.query(api.pages.history, { pageId: lobby, ...PAGE })).page.map((v) => crew.query(api.pages.version, { versionId: v._id }))),
			lobbyRead: await tools.readPage("Lobby"),
		};
		// Each was found, so nothing passes for being empty.
		expect(JSON.stringify(seen.lobbySteps)).toContain(kid);
		expect(seen.planSync).toBe("Only Office and Owners can see this page.");
		expect(seen.acme!.fields.find((f) => f.label === "Bid")).toMatchObject({ linksHidden: true });
		expect(seen.toolViews.error).toBe("Only Office and Owners can see this database.");
		const ownerSees = JSON.stringify([
			await owner.query(api.activity.list, {}),
			await owner.query(api.databaseViews.list, { typeId: vaultType }),
			await owner.query(api.records.linked, { recordId: acme, ...PAGE }),
			await owner.query(api.records.discussion, { recordId: acme }),
			await crew.query(api.typing.list, { chatId: await generalOf(owner) }),
		]);
		for (const there of ["Vaultbids", "Vaultview", "Vaultbid quartz", "Vault talk about Acme"]) expect(ownerSees).toContain(there);
		expect((await officeMember.query(api.typing.list, { chatId: room })).people.length).toBe(1);
		const text = JSON.stringify(seen);
		expect(text).not.toMatch(/vault/i);
		for (const id of [vaultType, bid, old, room, plan]) expect(text).not.toContain(id);
	});
});
