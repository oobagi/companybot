import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { type As, ownerAndMember, sideWorkspace, signIn } from "./helpers";

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
		types: () => t.query(internal.recordTools.typesFor, { turnId }),
		find: (input: object) => any(t.query(internal.recordTools.findFor, { turnId, input: { numItems: 20, ...input } })),
		get: (id: string) => any(t.query(internal.recordTools.getFor, { turnId, id })),
		save: (input: object) => any(t.mutation(internal.recordTools.saveFor, { turnId, input })),
		readChat: (chat: string) => any(t.query(internal.chatTools.readFor, { turnId, chat })),
		readPage: (page: string) => any(t.query(internal.pageTools.readFor, { turnId, page })),
		findPages: () => t.query(internal.pageTools.findFor, { turnId, input: {} }),
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
		expect((await tools.get(deal)).error).toBe("Only Office and Owners can see Deals.");
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
		await expect(crew.mutation(api.messages.send, { chatId: deals, text: "hi", mentions: { userIds: [], agentIds: [] } })).rejects.toThrow("Only Office and Owners can see #deals.");
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
