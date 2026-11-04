import type { ArrangementCommand, ArrangementList } from "@companybot/core/arrangements";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { type As, generalOf, ownerAndMember, setMemberSwitch, settle, sideWorkspace, workspaceOf } from "./helpers";

const idsOf = async (as: As, list: ArrangementList, entityId?: string) => (await as.query(api.arrangements.get))?.rows.find((r) => r.list === list && r.entityId === entityId)?.ids;
const change = (as: As, list: ArrangementList, command: ArrangementCommand, entityId?: string) => as.mutation(api.arrangements.change, { list, entityId, command });
const add = (id: string) => ({ op: "add", id }) as const;
const to = (id: string, beforeId: string | null, fill?: string[]) => ({ op: "move", id, beforeId, fill }) as const;
afterEach(() => vi.useRealTimers());

it("loads personal, shared and account rows together, isolated by person and workspace", async () => {
	const { t, owner, member } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	const other = await sideWorkspace(t, "owner@co.com");
	const general = await generalOf(owner);
	await change(owner, "tabs", to("drive", "chat", ["chat"]));
	await change(member, "channels", add(general._id));
	await change(owner, "workspaces", to(other.workspaceId, ws, [ws]));
	expect(await idsOf(owner, "tabs")).toEqual(["drive", "chat"]);
	expect((await owner.query(api.arrangements.get))?.rows.map((r) => r.list).sort()).toEqual(["channels", "tabs", "workspaces"]);
	expect(await idsOf(member, "tabs")).toBeUndefined();
	expect(await idsOf(member, "channels")).toEqual([general._id]);
	expect(await idsOf(owner.in(other.workspaceId), "tabs")).toBeUndefined();
	expect(await idsOf(owner.in(other.workspaceId), "workspaces")).toEqual([other.workspaceId, ws]);
	expect(await member.in(other.workspaceId).query(api.arrangements.get)).toBeNull();
});

it("keeps both devices' changes when each sends a command from the same stale snapshot", async () => {
	const { owner } = await ownerAndMember();
	const general = await generalOf(owner);
	const channels = [general._id, ...await Promise.all(["b", "c", "d"].map((name) => owner.mutation(api.chats.createChannel, { name, private: false })))];
	const [a, b, , d] = channels;
	for (const id of channels) await change(owner, "channels", add(id));
	// Both devices loaded this, then each built its change from it before either landed.
	const snapshot = (await idsOf(owner, "channels"))!;
	const fromA = [add("page:one"), to(d!, a!, channels.filter((id) => !snapshot.includes(id)))] as const;
	const fromB = [add("page:two"), to(b!, null, channels.filter((id) => !snapshot.includes(id)))] as const;
	await Promise.all([change(owner, "pins", fromA[0]), change(owner, "pins", fromB[0])]);
	await Promise.all([change(owner, "channels", fromA[1]), change(owner, "channels", fromB[1])]);
	expect(await idsOf(owner, "pins")).toEqual(["page:one", "page:two"]);
	const order = (await idsOf(owner, "channels"))!;
	expect(order.indexOf(d!)).toBeLessThan(order.indexOf(a!));
	expect(order.at(-1)).toBe(b);
	await change(owner, "recent", { op: "visit", id: "chat:x" });
	await change(owner, "recent", { op: "visit", id: "chat:y" });
	await change(owner, "folded", add("channels"));
	await change(owner, "folded", add("dms"));
	expect(await idsOf(owner, "recent")).toEqual(["chat:y", "chat:x"]);
	expect(await idsOf(owner, "folded")).toEqual(["channels", "dms"]);
});

it("needs sidebar.arrange to reorder shared lists; personal ones stay the member's to arrange", async () => {
	const { owner, member } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	const general = await generalOf(owner);
	const other = await owner.mutation(api.chats.createChannel, { name: "other", private: false });
	const type = (await owner.query(api.recordTypes.list))[0]!;
	const page = await owner.mutation(api.pages.create, { title: "Top" });
	const view = await owner.mutation(api.databaseViews.save, { typeId: type._id, name: "One", columns: ["name"], filters: [] });
	await setMemberSwitch(owner, "sidebar.arrange", false);
	expect((await member.query(api.arrangements.get))?.writable).toBe(false);
	for (const [list, command, entityId] of [["channels", to(other, general._id)], ["pages", to(page, null)], ["databases", to(type._id, null)], ["views", to(view, null), type._id], ["columns", add("name"), type._id]] as const)
		await expect(change(member, list, command, entityId)).rejects.toThrow("rearrange shared sidebar lists");
	await expect(member.mutation(api.recordTypes.setDisplay, { typeId: type._id, display: { layout: "board" } })).rejects.toThrow("rearrange shared sidebar lists");
	await member.mutation(api.arrangements.migrate, { list: "channels", ids: [general._id] });
	expect(await idsOf(owner, "channels")).toBeUndefined();
	// Rail tabs, pins and their order, DM order and folds are the member's own.
	await change(member, "tabs", to("drive", "chat", ["chat"]));
	await change(member, "pins", add(`chat:${general._id}`));
	await change(member, "pins", add(`page:${page}`));
	await change(member, "pinsOrder", to(`page:${page}`, `chat:${general._id}`, [`chat:${general._id}`]));
	const dms = (await member.query(api.chats.list))!.agents.map((agent) => agent._id as string);
	await change(member, "dms", to(dms[1]!, dms[0]!, [dms[0]!]));
	await change(member, "folded", add("channels"));
	await change(member, "channelFolds", add(general._id));
	await change(member, "workspaces", add(ws));
	expect(await idsOf(member, "tabs")).toEqual(["drive", "chat"]);
	expect(await idsOf(member, "pinsOrder")).toEqual([`page:${page}`, `chat:${general._id}`]);
	expect(await idsOf(member, "dms")).toEqual([dms[1], dms[0]]);
	expect(await idsOf(member, "folded")).toEqual(["channels"]);
	expect(await idsOf(member, "channelFolds")).toEqual([general._id]);
	expect(await idsOf(owner, "tabs")).toBeUndefined();
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
	await expect(change(owner, "pages", add(child), parent)).rejects.toThrow("not found");
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

it("ignores commands naming removed or foreign things, and drops malformed fill and seed ids", async () => {
	const { t, owner } = await ownerAndMember();
	const other = await sideWorkspace(t, "owner@co.com");
	const channel = await generalOf(owner);
	const foreign = await owner.in(other.workspaceId).mutation(api.chats.createChannel, { name: "foreign", private: false });
	const gone = await owner.mutation(api.chats.createChannel, { name: "gone", private: false });
	await owner.mutation(api.trash.move, { kind: "channel", id: gone });
	const gonePage = await owner.mutation(api.pages.create, { title: "Gone" });
	await owner.mutation(api.trash.move, { kind: "page", id: gonePage });
	const type = (await owner.query(api.recordTypes.list))[0]!;
	const deletedView = await owner.mutation(api.databaseViews.save, { typeId: type._id, name: "Gone", columns: ["name"], filters: [] });
	await owner.mutation(api.databaseViews.remove, { viewId: deletedView, version: 1 });
	const cases: [ArrangementList, string, string?][] = [["channels", gone], ["channels", foreign], ["pages", gonePage], ["views", deletedView, type._id], ["databases", "deleted"], ["columns", "deleted", type._id], ["folded", "deleted"], ["tabs", "nope"], ["channelFolds", gone]];
	for (const [list, id, entityId] of cases) {
		await change(owner, list, add(id), entityId);
		await change(owner, list, to(id, null), entityId);
		expect(await idsOf(owner, list, entityId), `${list} ${id}`).toBeUndefined();
	}
	await change(owner, "channels", to(channel._id, null, ["not-an-id", gone]));
	expect(await idsOf(owner, "channels")).toEqual([gone, channel._id]);
	await change(owner, "columns", { op: "remove", id: "status", seed: ["name", "status", "deleted"] }, type._id);
	expect(await idsOf(owner, "columns", type._id)).toEqual(["name"]);
});

it("keeps private channels' slots when someone who can't see them reorders", async () => {
	const { owner, member } = await ownerAndMember();
	const general = await generalOf(owner);
	const privateId = await owner.mutation(api.chats.createChannel, { name: "private", private: true });
	const publicId = await owner.mutation(api.chats.createChannel, { name: "public", private: false });
	for (const id of [general._id, privateId, publicId]) await change(owner, "channels", add(id));
	await change(member, "channels", to(publicId, general._id));
	expect(await idsOf(owner, "channels")).toEqual([publicId, general._id, privateId]);
	expect((await member.query(api.chats.list))!.channels.map((c) => c._id)).not.toContain(privateId);
});

it("deletes entity arrangements when pages and databases are deleted forever", async () => {
	const { t, owner } = await ownerAndMember();
	const page = await owner.mutation(api.pages.create, { title: "Parent" });
	const child = await owner.mutation(api.pages.create, { title: "Child", parentId: page });
	const type = (await owner.query(api.recordTypes.list))[0]!;
	const view = await owner.mutation(api.databaseViews.save, { typeId: type._id, name: "One", columns: ["name"], filters: [] });
	await change(owner, "pages", add(child), page);
	await change(owner, "views", add(view), type._id);
	await change(owner, "columns", add("name"), type._id);
	expect(await t.run((ctx) => ctx.db.query("arrangements").collect())).toHaveLength(3);
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
	const general = await generalOf(owner);
	await change(member, "tabs", add("chat"));
	await change(member, "workspaces", add(ws));
	await change(owner, "tabs", add("drive"));
	await change(owner, "channels", add(general._id));
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
