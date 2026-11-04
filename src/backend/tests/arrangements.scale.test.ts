import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { CHANNEL_READS_MAX, IMPORT_IDS_MAX, PAGE_LEVEL_MAX, PAGE_READS_MAX } from "../convex/arrangements";
import { generalOf, ownerAndMember, workspaceOf } from "./helpers";

// A command reads only the ids it names, and `get` reads channel docs in one capped range,
// so a 2,000-channel order stays under Convex's per-transaction limits for both.
it("saves and loads a 2,000-channel order without exceeding transaction limits", { timeout: 600_000 }, async () => {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const general = await generalOf(owner);
	const ids: Id<"chats">[] = [];
	for (let start = 0; start < 2_000; start += 200) await t.run(async (ctx) => {
		for (let i = start; i < start + 200; i++) ids.push(await ctx.db.insert("chats", { workspaceId, kind: "channel", name: `c${i}`, private: false, archived: false, createdBy: owner.userId, lastMessageAt: 0 }));
	});
	// The first drag of a never-saved list fills it with every channel shown before the drop.
	await owner.mutation(api.arrangements.change, { list: "channels", command: { op: "move", id: general._id, beforeId: null, fill: ids } });
	await member.mutation(api.arrangements.change, { list: "channels", command: { op: "move", id: ids[1_999]!, beforeId: ids[0]! } });
	await owner.mutation(api.arrangements.change, { list: "pins", command: { op: "add", id: `chat:${ids[5]}` } });
	const rows = (await member.query(api.arrangements.get))!.rows;
	const order = rows.find((r) => r.list === "channels")!.ids;
	// `get` reads at most 1,000 channel docs (#general and the first 999); the rest of the order is left out.
	expect(order).toHaveLength(CHANNEL_READS_MAX);
	expect(order.slice(0, 2)).toEqual([ids[0], ids[1]]);
	expect(order.at(-1)).toBe(general._id);
	const saved = await t.run(async (ctx) => (await ctx.db.query("arrangements").withIndex("by_list", (q) => q.eq("workspaceId", workspaceId).eq("userId", undefined).eq("list", "channels")).unique())!.ids);
	// `fill` is cut to the same 1,000-channel view; the member's move adds the 2,000th channel back in.
	expect(saved).toHaveLength(CHANNEL_READS_MAX + 1);
	expect(saved.slice(0, 2)).toEqual([ids[1_999], ids[0]]);
});

it("returns at most 500 of a 600-page level, and still moves one", { timeout: 600_000 }, async () => {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const ids: Id<"pages">[] = [];
	for (let start = 0; start < 600; start += 200) await t.run(async (ctx) => {
		for (let i = start; i < start + 200; i++) ids.push(await ctx.db.insert("pages", { workspaceId, title: `Page ${i}`, archived: false, createdBy: owner.userId, updatedBy: owner.userId, updatedAt: 0 }));
	});
	await t.run((ctx) => ctx.db.insert("arrangements", { workspaceId, list: "pages", ids }));
	const level = (await member.query(api.arrangements.get))!.rows.find((r) => r.list === "pages")!.ids;
	expect(level).toEqual(ids.slice(0, PAGE_LEVEL_MAX));
	await member.mutation(api.arrangements.change, { list: "pages", command: { op: "move", id: ids[499]!, beforeId: ids[0]! } });
	const saved = (await owner.query(api.arrangements.get))!.rows.find((r) => r.list === "pages")!.ids;
	expect(saved.slice(0, 2)).toEqual([ids[499], ids[0]]);
});

it("imports 1,100 channels with 18 KB topics: the first 100, without failing, so the app clears its key", { timeout: 600_000 }, async () => {
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const topic = "x".repeat(18_000);
	const ids: Id<"chats">[] = [];
	for (let start = 0; start < 1_100; start += 100) await t.run(async (ctx) => {
		for (let i = start; i < start + 100; i++) ids.push(await ctx.db.insert("chats", { workspaceId, kind: "channel", name: `c${i}`, topic, private: false, archived: false, createdBy: owner.userId, lastMessageAt: 0 }));
	});
	await owner.mutation(api.arrangements.migrate, { list: "channels", ids });
	const row = await t.run((ctx) => ctx.db.query("arrangements").withIndex("by_list", (q) => q.eq("workspaceId", workspaceId).eq("userId", undefined).eq("list", "channels")).unique());
	expect(row!.ids).toEqual(ids.slice(0, IMPORT_IDS_MAX));
});

it("BUG get survives channel topics exceeding 16 MiB in total", { timeout: 600_000 }, async () => {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	// Topics from before the 250-character cap, not yet cut by migrations.channelTopics.
	const topic = "x".repeat(18_000);
	const ids: Id<"chats">[] = [];
	for (let start = 0; start < 1_100; start += 100) await t.run(async (ctx) => {
		for (let i = start; i < start + 100; i++) ids.push(await ctx.db.insert("chats", { workspaceId, kind: "channel", name: `c${i}`, topic, private: false, archived: false, createdBy: owner.userId, lastMessageAt: 0 }));
	});
	await t.run((ctx) => ctx.db.insert("arrangements", { workspaceId, list: "channels", ids }));
	const order = (await member.query(api.arrangements.get))!.rows.find((r) => r.list === "channels")!.ids;
	expect(order.length).toBeGreaterThan(0);
	expect(order.length).toBeLessThan(ids.length);
	expect(order).toEqual(ids.slice(0, order.length));
});

/** `count` top-level pages, each with one child, and each child level saved. */
async function levels(count: number) {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const page = { workspaceId, archived: false, createdBy: owner.userId, updatedBy: owner.userId, updatedAt: 0 };
	for (let start = 0; start < count; start += 100) await t.run(async (ctx) => {
		for (let i = start; i < Math.min(count, start + 100); i++) {
			const parentId = await ctx.db.insert("pages", { ...page, title: `Parent ${i}` });
			const child = await ctx.db.insert("pages", { ...page, title: `Child ${i}`, parentId });
			await ctx.db.insert("arrangements", { workspaceId, list: "pages", entityId: parentId, ids: [child] });
		}
	});
	return (await member.query(api.arrangements.get))!.rows.filter((r) => r.list === "pages" && r.entityId);
}

it("BUG get counts parent checks in its 2000 page-read cap", { timeout: 600_000 }, async () => {
	// Each level reads its parent and its child: the cap is reached after half as many levels.
	expect(await levels(1_200)).toHaveLength(PAGE_READS_MAX / 2);
});

it("BUG get survives 1500 saved parent-child levels", { timeout: 600_000 }, async () => {
	const shown = await levels(1_500);
	expect(shown.length).toBeGreaterThan(0);
	expect(shown.length).toBeLessThanOrEqual(PAGE_READS_MAX / 2);
});
