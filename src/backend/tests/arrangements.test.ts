import { permissions } from "@companybot/core/permissions";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { generalOf, ownerAndMember, settle, sideWorkspace, workspaceOf } from "./helpers";

afterEach(() => vi.useRealTimers());

it("keeps personal lists separate and shares workspace lists; workspace order follows the account", async () => {
	const { t, owner, member } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	await owner.mutation(api.arrangements.set, { key: "rail.tabs", ids: ["drive", "chat"] });
	expect((await owner.query(api.arrangements.get, { key: "rail.tabs" })).ids).toEqual(["drive", "chat"]);
	expect((await member.query(api.arrangements.get, { key: "rail.tabs" })).ids).toBeNull();
	const key = `sidebar.channels:${ws}`;
	const general = await generalOf(owner);
	await member.mutation(api.arrangements.set, { key, ids: [general._id] });
	expect((await owner.query(api.arrangements.get, { key })).ids).toEqual([general._id]);
	const side = await sideWorkspace(t, "owner@co.com");
	await owner.mutation(api.arrangements.set, { key: "rail.order", ids: [side.workspaceId, ws] });
	expect((await owner.in(side.workspaceId).query(api.arrangements.get, { key: "rail.order" })).ids).toEqual([side.workspaceId, ws]);
	expect((await member.query(api.arrangements.get, { key: "rail.order" })).ids).toBeNull();
});

it("requires sidebar.arrange for shared writes, including imports; personal choices remain writable", async () => {
	const { owner, member } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	// Simulate a role without this permission, ahead of custom workspace roles.
	const roles = permissions["sidebar.arrange"].roles as unknown as string[];
	const before = [...roles];
	roles.splice(roles.indexOf("member"), 1);
	try {
		const key = `sidebar.channels:${ws}`;
		expect((await member.query(api.arrangements.get, { key })).writable).toBe(false);
		await expect(member.mutation(api.arrangements.set, { key, ids: [] })).rejects.toThrow("arrange the sidebar");
		await member.mutation(api.arrangements.migrate, { key, ids: ["old"] });
		expect((await owner.query(api.arrangements.get, { key })).ids).toBeNull();
		await member.mutation(api.arrangements.set, { key: "sidebar.folded", ids: ["channels"] });
	} finally { roles.splice(0, roles.length, ...before); }
});

it("isolates workspace and entity keys and rejects invented arrangement keys", async () => {
	const { t, owner, member } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	const side = await sideWorkspace(t, "owner@co.com");
	const foreignKey = `sidebar.channels:${side.workspaceId}`;
	await owner.in(side.workspaceId).mutation(api.arrangements.set, { key: foreignKey, ids: ["private"] });
	expect((await owner.query(api.arrangements.get, { key: foreignKey })).ids).toBeNull();
	await expect(member.mutation(api.arrangements.set, { key: foreignKey, ids: [] })).rejects.toThrow("not found");
	await member.mutation(api.arrangements.migrate, { key: foreignKey, ids: [] });
	expect((await owner.in(side.workspaceId).query(api.arrangements.get, { key: foreignKey })).ids).toEqual(["private"]);
	const typeId = await t.run((ctx) => ctx.db.insert("recordTypes", { workspaceId: side.workspaceId, key: "secret", name: "Secret", plural: "Secrets", archived: false, createdBy: owner.userId, updatedAt: Date.now() }));
	for (const key of [`views.order:${typeId}`, `records.columns.secret`, `sidebar.pages:${ws}:missing`, "made.up", "sidebar.width"]) {
		await expect(member.mutation(api.arrangements.set, { key, ids: [] })).rejects.toThrow("not found");
		expect((await member.query(api.arrangements.get, { key })).ids).toBeNull();
	}
});

it("imports once without overwriting a saved list and discards keys for deleted things", async () => {
	const { owner } = await ownerAndMember();
	await owner.mutation(api.arrangements.migrate, { key: "rail.tabs", ids: ["drive", "chat"] });
	await owner.mutation(api.arrangements.migrate, { key: "rail.tabs", ids: ["databases"] });
	expect((await owner.query(api.arrangements.get, { key: "rail.tabs" })).ids).toEqual(["drive", "chat"]);
	await owner.mutation(api.arrangements.migrate, { key: "views.order:deleted", ids: ["gone"] });
	expect((await owner.query(api.arrangements.get, { key: "views.order:deleted" })).ids).toBeNull();
});

it("deletes personal rows on leaving, account rows on erasure, and every workspace row on deletion", async () => {
	const { t, owner, member } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	await member.mutation(api.arrangements.set, { key: "rail.tabs", ids: ["chat"] });
	await member.mutation(api.arrangements.set, { key: "rail.order", ids: [ws] });
	await owner.mutation(api.arrangements.set, { key: "rail.tabs", ids: ["drive"] });
	await owner.mutation(api.arrangements.set, { key: `sidebar.channels:${ws}`, ids: [] });
	vi.useFakeTimers();
	await member.mutation(api.workspace.leave);
	await settle(t);
	const rows = () => t.run((ctx) => ctx.db.query("arrangements").collect());
	expect((await rows()).filter((r) => r.userId === member.userId).map((r) => r.key)).toEqual(["rail.order"]);
	await member.mutation(api.workspace.eraseAccount);
	await settle(t);
	expect((await rows()).some((r) => r.userId === member.userId)).toBe(false);
	await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
	await settle(t);
	expect(await rows()).toEqual([]);
});

it("shares database display and each page level while keeping folds and expanded pages personal", async () => {
	const { t, owner, member } = await ownerAndMember();
	const ws = await workspaceOf(owner);
	const typeId = await t.run(async (ctx) => (await ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).first())!._id);
	const type = await t.run((ctx) => ctx.db.get(typeId));
	const pageId = await owner.mutation(api.pages.create, { title: "Parent" });
	for (const key of [`sidebar.databases:${ws}`, `views.order:${typeId}`, `records.columns.${type!.key}`, `sidebar.pages:${ws}:top`, `sidebar.pages:${ws}:${pageId}`]) {
		await member.mutation(api.arrangements.set, { key, ids: ["first", "second"] });
		expect((await owner.query(api.arrangements.get, { key })).ids).toEqual(["first", "second"]);
	}
	const key = `records.layout.${type!.key}`;
	await member.mutation(api.arrangements.set, { key, ids: ["board", "status"] });
	expect((await owner.query(api.arrangements.get, { key })).ids).toEqual(["board", "status"]);
	await expect(member.mutation(api.arrangements.set, { key, ids: ["unknown"] })).rejects.toThrow("table or board");
	for (const key of [`pages-expanded:${ws}`, `sidebar.channels.folded:${ws}`, `sidebar.dms.folded:${ws}`, `rail.pins:${ws}`, `rail.recent:${ws}`, `rail.pins.order:${ws}`, `sidebar.dms:${ws}`, "sidebar.sections", "sidebar.folded"]) {
		await owner.mutation(api.arrangements.set, { key, ids: ["mine"] });
		expect((await member.query(api.arrangements.get, { key })).ids).toBeNull();
	}
});
