import type { ArrangementList } from "@companybot/core/arrangements";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { type As, generalOf, ownerAndMember, setMemberSwitch, settle, sideWorkspace, workspaceOf } from "./helpers";

const idsOf = async (as: As, list: ArrangementList, entityId?: string) => (await as.query(api.arrangements.get))?.rows.find((r) => r.list === list && r.entityId === entityId)?.ids;
afterEach(() => vi.useRealTimers());

it("loads personal, shared and account rows together, isolated by person and workspace", async () => {
	const { t, owner, member } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	const other = await sideWorkspace(t, "owner@co.com");
	const general = await generalOf(owner);
	await owner.mutation(api.arrangements.set, { list: "tabs", ids: ["drive", "chat"] });
	await member.mutation(api.arrangements.set, { list: "channels", ids: [general._id] });
	await owner.mutation(api.arrangements.set, { list: "workspaces", ids: [other.workspaceId, ws] });
	expect((await owner.query(api.arrangements.get))?.rows.map((r) => r.list).sort()).toEqual(["channels", "tabs", "workspaces"]);
	expect(await idsOf(member, "tabs")).toBeUndefined();
	expect(await idsOf(member, "channels")).toEqual([general._id]);
	expect(await idsOf(owner.in(other.workspaceId), "tabs")).toBeUndefined();
	expect(await idsOf(owner.in(other.workspaceId), "workspaces")).toEqual([other.workspaceId, ws]);
	expect(await member.in(other.workspaceId).query(api.arrangements.get)).toBeNull();
});

it("checks sidebar.arrange for shared lists and display; personal choices remain writable", async () => {
	const { owner, member } = await ownerAndMember();
	const type = (await owner.query(api.recordTypes.list))[0]!;
	await setMemberSwitch(owner, "sidebar.arrange", false);
	expect((await member.query(api.arrangements.get))?.writable).toBe(false);
	await expect(member.mutation(api.arrangements.set, { list: "channels", ids: [] })).rejects.toThrow("rearrange shared sidebar lists");
	await expect(member.mutation(api.recordTypes.setDisplay, { typeId: type._id, display: { layout: "board" } })).rejects.toThrow("rearrange shared sidebar lists");
	await member.mutation(api.arrangements.migrate, { list: "channels", ids: [] });
	expect(await idsOf(owner, "channels")).toBeUndefined();
	await member.mutation(api.arrangements.set, { list: "folded", ids: ["channels"] });
});

it("validates an imported page against the destination workspace, even when another is open", async () => {
	const { t, owner } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	const other = await sideWorkspace(t, "owner@co.com");
	const page = await owner.mutation(api.pages.create, { title: "In the open workspace" });
	// Never valid, so it's skipped (not thrown) and the importer can clear the key.
	await owner.mutation(api.arrangements.migrate, { targetWorkspaceId: other.workspaceId, list: "pages", entityId: page, ids: [] });
	expect(await idsOf(owner.in(other.workspaceId), "pages", page)).toBeUndefined();
	const parent = await owner.in(other.workspaceId).mutation(api.pages.create, { title: "Destination parent" });
	const child = await owner.in(other.workspaceId).mutation(api.pages.create, { title: "Destination child", parentId: parent });
	await owner.mutation(api.arrangements.migrate, { targetWorkspaceId: other.workspaceId, list: "pages", entityId: parent, ids: [page, child] });
	expect(await idsOf(owner.in(other.workspaceId), "pages", parent)).toEqual([child]);
	await expect(owner.mutation(api.arrangements.set, { list: "pages", entityId: parent, ids: [] })).rejects.toThrow("not found");
	expect(await idsOf(owner.in(ws), "pages", parent)).toBeUndefined();
});

it("imports only absent lists, resolves database keys once, and stores layout on the database", async () => {
	const { owner } = await ownerAndMember();
	const type = (await owner.query(api.recordTypes.list))[0]!;
	await owner.mutation(api.arrangements.migrate, { list: "tabs", ids: ["drive", "chat"] });
	await owner.mutation(api.arrangements.migrate, { list: "tabs", ids: ["databases"] });
	expect(await idsOf(owner, "tabs")).toEqual(["drive", "chat"]);
	await owner.mutation(api.arrangements.migrate, { list: "columns", databaseKey: type.key, ids: ["name"] });
	await owner.mutation(api.arrangements.migrate, { list: "databases", ids: [type.key, "deleted"] });
	expect(await idsOf(owner, "columns", type._id)).toEqual(["name"]);
	expect(await idsOf(owner, "databases")).toEqual([type._id]);
	await owner.mutation(api.recordTypes.migrateDisplay, { databaseKey: type.key, display: { layout: "board" } });
	await owner.mutation(api.recordTypes.migrateDisplay, { databaseKey: type.key, display: { layout: "table" } });
	expect((await owner.query(api.recordTypes.list)).find((t) => t._id === type._id)?.display).toEqual({ layout: "board" });
	await owner.mutation(api.recordTypes.setDisplay, { typeId: type._id, display: { layout: "table" } });
	expect((await owner.query(api.recordTypes.list)).find((t) => t._id === type._id)?.display).toEqual({ layout: "table" });
	await expect(owner.mutation(api.recordTypes.setDisplay, { typeId: type._id, display: { layout: "board", groupBy: "missing" } })).rejects.toThrow("live choice field");
});

it("merges display changes so layout and grouping don't overwrite each other; imports that can't succeed are skipped", async () => {
	const { owner, member } = await ownerAndMember();
	const type = (await owner.query(api.recordTypes.list))[0]!;
	const choice = type.fields.find((f) => f.kind === "choice" && !f.multiple)!;
	const displayOf = async () => (await owner.query(api.recordTypes.list)).find((t) => t._id === type._id)?.display;
	await owner.mutation(api.recordTypes.setDisplay, { typeId: type._id, display: { groupBy: choice.key } });
	await member.mutation(api.recordTypes.setDisplay, { typeId: type._id, display: { layout: "board" } });
	expect(await displayOf()).toEqual({ layout: "board", groupBy: choice.key });
	await setMemberSwitch(owner, "sidebar.arrange", false);
	const fresh = (await owner.query(api.recordTypes.list))[1]!;
	await member.mutation(api.recordTypes.migrateDisplay, { databaseKey: fresh.key, display: { layout: "board" } });
	await owner.mutation(api.recordTypes.migrateDisplay, { databaseKey: fresh.key, display: { layout: "board", groupBy: "gone" } });
	expect((await owner.query(api.recordTypes.list)).find((t) => t._id === fresh._id)?.display).toEqual({ layout: "board" });
});

it("prunes removed and foreign channels, pages, views, databases, columns and folds on save", async () => {
	const { t, owner } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	const other = await sideWorkspace(t, "owner@co.com");
	const channel = await generalOf(owner);
	const foreign = await owner.in(other.workspaceId).mutation(api.chats.createChannel, { name: "foreign", private: false });
	const gone = await owner.mutation(api.chats.createChannel, { name: "gone", private: false });
	await owner.mutation(api.trash.move, { kind: "channel", id: gone });
	const page = await owner.mutation(api.pages.create, { title: "Live" });
	const gonePage = await owner.mutation(api.pages.create, { title: "Gone" });
	await owner.mutation(api.trash.move, { kind: "page", id: gonePage });
	const type = (await owner.query(api.recordTypes.list))[0]!;
	const view = await owner.mutation(api.databaseViews.save, { typeId: type._id, name: "One", columns: ["name"], filters: [] });
	const deletedView = await owner.mutation(api.databaseViews.save, { typeId: type._id, name: "Gone", columns: ["name"], filters: [] });
	await owner.mutation(api.databaseViews.remove, { viewId: deletedView, version: 1 });
	const cases = [
		{ list: "channels" as const, ids: [gone, foreign, channel._id], expected: [channel._id] },
		{ list: "pages" as const, ids: [gonePage, page, foreign], expected: [page] },
		{ list: "views" as const, entityId: type._id, ids: [deletedView, view], expected: [view] },
		{ list: "databases" as const, ids: ["deleted", type._id], expected: [type._id] },
		{ list: "columns" as const, entityId: type._id, ids: ["deleted", "name"], expected: ["name"] },
		{ list: "folded" as const, ids: ["deleted", "channels"], expected: ["channels"] },
		{ list: "channelFolds" as const, ids: [gone, channel._id], expected: [channel._id] },
	];
	for (const { expected, ...args } of cases) {
		await owner.mutation(api.arrangements.set, args);
		expect(await idsOf(owner, args.list, "entityId" in args ? args.entityId : undefined)).toEqual(expected);
	}
	expect(ws).toBeDefined();
});

it("filters private channel ids on reads and preserves their slots when another member saves", async () => {
	const { t, owner, member } = await ownerAndMember();
	const general = await generalOf(owner);
	const privateId = await owner.mutation(api.chats.createChannel, { name: "private", private: true });
	const publicId = await owner.mutation(api.chats.createChannel, { name: "public", private: false });
	await owner.mutation(api.arrangements.set, { list: "channels", ids: [general._id, privateId, publicId] });
	expect(await idsOf(member, "channels")).toEqual([general._id, publicId]);
	await member.mutation(api.arrangements.set, { list: "channels", ids: [publicId, general._id] });
	expect(await idsOf(owner, "channels")).toEqual([publicId, privateId, general._id]);
	expect(await idsOf(member, "channels")).toEqual([publicId, general._id]);
	await owner.mutation(api.trash.move, { kind: "channel", id: privateId });
	expect(await idsOf(owner, "channels")).toEqual([publicId, general._id]);
});

it("deletes entity arrangements when pages and databases are deleted forever", async () => {
	const { t, owner } = await ownerAndMember();
	const page = await owner.mutation(api.pages.create, { title: "Parent" });
	const type = (await owner.query(api.recordTypes.list))[0]!;
	await owner.mutation(api.arrangements.set, { list: "pages", entityId: page, ids: [] });
	await owner.mutation(api.arrangements.set, { list: "views", entityId: type._id, ids: [] });
	await owner.mutation(api.arrangements.set, { list: "columns", entityId: type._id, ids: ["name"] });
	vi.useFakeTimers();
	for (const [kind, id] of [["page", page], ["database", type._id]] as const) {
		await owner.mutation(api.trash.move, { kind, id });
		await owner.mutation(api.trash.purge, { id });
	}
	await settle(t);
	expect(await t.run((ctx) => ctx.db.query("arrangements").collect())).toEqual([]);
});

it("cleans personal rows on leaving/erasure and every workspace row on workspace deletion", async () => {
	const { t, owner, member } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	await member.mutation(api.arrangements.set, { list: "tabs", ids: ["chat"] });
	await member.mutation(api.arrangements.set, { list: "workspaces", ids: [ws] });
	await owner.mutation(api.arrangements.set, { list: "tabs", ids: ["drive"] });
	await owner.mutation(api.arrangements.set, { list: "channels", ids: [] });
	vi.useFakeTimers();
	await member.mutation(api.workspace.leave);
	await settle(t);
	const rows = () => t.run((ctx) => ctx.db.query("arrangements").collect());
	expect((await rows()).filter((r) => r.userId === member.userId).map((r) => r.list)).toEqual(["workspaces"]);
	await member.mutation(api.workspace.eraseAccount);
	await settle(t);
	expect((await rows()).some((r) => r.userId === member.userId)).toBe(false);
	await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
	await settle(t);
	expect(await rows()).toEqual([]);
});
