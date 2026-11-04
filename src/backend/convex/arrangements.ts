import { applyCommand, arrangementLists, extraIds, railTabs, sidebarSections, type Arrangement, type ArrangementList } from "@companybot/core/arrangements";
import { can } from "@companybot/core/permissions";
import { ConvexError, getDocumentSize, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canSee } from "./chatOps";
import { pageVisible } from "./pageOps";
import { chatAccess, reach } from "./placeAccess";
import { typesOf } from "./recordOps";
import { mutation, query } from "./functions";
import { type Member, checkPermission, getMember, memberOf, requireMember, requireUserId } from "./lib";
import { arrangementList } from "./schema";

type Target = { list: ArrangementList; entityId?: string };
type Place = { workspaceId?: Id<"workspaces">; userId?: Id<"users">; list: ArrangementList; entityId?: Id<"pages"> | Id<"recordTypes"> };
const targetArgs = { list: arrangementList, entityId: v.optional(v.string()) };

/** A page level's ids read one by one (siblings under one parent): at most this many, the rest dropped from what's returned. */
export const PAGE_LEVEL_MAX = 500;
/** Page docs one call reads in all, levels, parents and their ancestors alike, so it stays under 4,096 index ranges. */
export const PAGE_READS_MAX = 2_000;
/** Channel docs `get` reads to know which ones someone sees; past either cap the rest of the order is left out. */
export const CHANNEL_READS_MAX = 1_000;
const CHANNEL_BYTES_MAX = 8 * 1024 * 1024;

/** Thrown when a call has read `PAGE_READS_MAX` pages: `get` leaves that level out. */
class OutOfPageReads extends Error {}

/**
 * What of each list someone may see, so nobody receives or moves an id they can't see. Channels and
 * databases take two and one indexed reads in all (channels capped); pages go through one cached,
 * budgeted reader shared by levels, parents and ancestors. Personal lists pass through.
 */
function viewer(ctx: QueryCtx, member: Member) {
	const channels = once(async () => {
		const seats = await ctx.db.query("chatMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("userId", member.userId)).collect();
		const mine = new Set<string>(seats.map((s) => s.chatId));
		const seen = new Set<string>();
		let count = 0;
		let bytes = 0;
		for await (const c of ctx.db.query("chats").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("kind", "channel"))) {
			if (!c.archived && (!c.private || mine.has(c._id)) && reach(member, chatAccess(c))) seen.add(c._id);
			bytes += getDocumentSize(c);
			if (++count >= CHANNEL_READS_MAX || bytes >= CHANNEL_BYTES_MAX) break;
		}
		return seen;
	});
	const types = once(async () => new Set<string>((await typesOf(ctx, member.workspaceId)).filter((t) => !t.archived && reach(member, t.access)).map((t) => t._id)));
	const pages = new Map<string, Promise<Doc<"pages"> | null>>();
	let pageReads = PAGE_READS_MAX;
	const readPage = (id: Id<"pages">) => {
		let doc = pages.get(id);
		if (!doc) {
			if (pageReads-- <= 0) throw new OutOfPageReads();
			pages.set(id, (doc = ctx.db.get(id)));
		}
		return doc;
	};
	const pageSeen = pageVisible(ctx, member, readPage);
	const page = async (id: string) => {
		const pageId = ctx.db.normalizeId("pages", id);
		const doc = pageId && await readPage(pageId);
		return doc && !doc.archived && !doc.recordId && doc.workspaceId === member.workspaceId && await pageSeen(doc) ? doc : null;
	};
	const viewsOf = async (typeId: string) => {
		const id = ctx.db.normalizeId("recordTypes", typeId);
		if (!id || !(await types()).has(id)) return new Set<string>();
		const views = await ctx.db.query("databaseViews").withIndex("by_type", (q) => q.eq("typeId", id)).collect();
		return new Set<string>(views.filter((view) => view.workspaceId === member.workspaceId).map((view) => view._id));
	};
	return {
		page,
		/** Whether a page level's parent is visible; a call out of page reads can't tell, so it leaves the level out. */
		pageLevel: async (parentId: string) => { try { return !!(await page(parentId)); } catch (e) { if (e instanceof OutOfPageReads) return false; throw e; } },
		database: async (id: string) => (await types()).has(id),
		/** The ids of a list this person may see, in order. Null: the whole list is hidden from them (or out of reads). */
		filter: async (list: ArrangementList, entityId: string | undefined, ids: string[]): Promise<string[] | null> => {
			switch (list) {
				case "channels": case "channelFolds": { const seen = await channels(); return ids.filter((id) => seen.has(id)); }
				case "databases": { const seen = await types(); return ids.filter((id) => seen.has(id)); }
				case "views": case "columns": return (await types()).has(entityId!) ? ids : null;
				case "pages": {
					const kept: string[] = [];
					try {
						for (const id of ids.slice(0, PAGE_LEVEL_MAX)) if (await page(id)) kept.push(id);
					} catch (e) {
						if (e instanceof OutOfPageReads) return null;
						throw e;
					}
					return kept;
				}
				default: return ids;
			}
		},
		/** `fill` ids for a database's views: only ones that exist, here, in that database. */
		views: viewsOf,
	};
}
type Viewer = ReturnType<typeof viewer>;

function once<T>(load: () => Promise<T>) {
	let value: Promise<T> | undefined;
	return () => (value ??= load());
}

/** Where a list lives, if the person can see what it belongs to: a hidden page or database reads as missing. */
async function placeOf(ctx: QueryCtx, member: Member, target: Target, seen: Viewer): Promise<Place | null> {
	const definition = arrangementLists[target.list];
	let entityId: Place["entityId"];
	if (definition.entity === "pages") {
		if (target.entityId) {
			const parent = await seen.page(target.entityId);
			if (!parent || parent.recordId) return null;
			entityId = parent._id;
		}
	} else if (definition.entity === "recordTypes") {
		const id = target.entityId && ctx.db.normalizeId("recordTypes", target.entityId);
		if (!id || !(await seen.database(id))) return null;
		entityId = id;
	} else if (target.entityId) return null;
	return { list: target.list, entityId, workspaceId: definition.scope === "account" ? undefined : member.workspaceId, userId: definition.scope === "shared" ? undefined : member.userId };
}
const rowOf = (ctx: QueryCtx, place: Place) => ctx.db.query("arrangements").withIndex("by_list", (q) => q.eq("workspaceId", place.workspaceId).eq("userId", place.userId).eq("list", place.list).eq("entityId", place.entityId)).unique();

const columnsOf = async (ctx: QueryCtx, target: Target) => {
	const typeId = ctx.db.normalizeId("recordTypes", target.entityId!)!;
	const fields = await ctx.db.query("recordFields").withIndex("by_type", (q) => q.eq("typeId", typeId)).collect();
	return new Set(fields.filter((f) => !f.archived).map((f) => f.key));
};

/** Reads one doc, counting its size against a budget when there is one (the legacy import's). */
type Read = <T extends "chats" | "pages" | "databaseViews" | "agents">(table: T, id: string) => Promise<Doc<T> | null>;
const reader = (ctx: QueryCtx, budget?: { bytes: number }): Read => async (table, id) => {
	const docId = ctx.db.normalizeId(table, id);
	const doc = docId ? await ctx.db.get(docId) : null;
	if (budget && doc) budget.bytes -= getDocumentSize(doc);
	return doc as never;
};

/**
 * Whether one id is something live this list can hold and the person can see: one to three reads, so
 * only for the ids a command names (and the bounded import).
 */
async function live(ctx: QueryCtx, member: Member, target: Target, id: string, seen: Viewer, columns?: Set<string>, read = reader(ctx)) {
	switch (target.list) {
		case "channels": case "channelFolds": {
			const chat = await read("chats", id);
			return !!chat && !chat.archived && chat.workspaceId === member.workspaceId && chat.kind === "channel" && await canSee(ctx, chat, member);
		}
		case "pages": case "expanded": {
			const page = await read("pages", id);
			return !!page && !page.archived && !page.recordId && page.workspaceId === member.workspaceId && (target.list === "expanded" || (page.parentId ?? undefined) === target.entityId) && !!await seen.page(id);
		}
		case "views": {
			const view = await read("databaseViews", id);
			return !!view && view.workspaceId === member.workspaceId && view.typeId === target.entityId;
		}
		case "databases": return seen.database(id);
		case "dms": case "dmFolds": {
			const agent = await read("agents", id);
			const chat = await read("chats", id);
			return !!(agent && !agent.archived && agent.workspaceId === member.workspaceId) || !!(chat && !chat.archived && chat.kind === "dm" && await canSee(ctx, chat, member));
		}
		case "columns": return (columns ?? await columnsOf(ctx, target)).has(id);
		case "workspaces": {
			const ws = ctx.db.normalizeId("workspaces", id);
			return !!ws && !!await memberOf(ctx, member.userId, ws);
		}
		default: return shaped(ctx, target.list, id);
	}
}

/** Whether an id could belong in this list, without reading it: for `fill` and `seed` in lists nobody's hidden from. */
function shaped(ctx: QueryCtx, list: ArrangementList, id: string) {
	switch (list) {
		case "dms": case "dmFolds": return !!(ctx.db.normalizeId("agents", id) || ctx.db.normalizeId("chats", id));
		case "workspaces": return !!ctx.db.normalizeId("workspaces", id);
		case "expanded": return !!ctx.db.normalizeId("pages", id);
		case "sections": case "folded": return sidebarSections.includes(id);
		case "tabs": return railTabs.includes(id);
		default: return true;
	}
}

/**
 * Every list the open workspace has for this person, cut to what they may see (`viewer`): stored ids,
 * never one read per channel. A list whose page or database they can't open is left out.
 */
export const get = query({
	args: {},
	handler: async (ctx): Promise<{ rows: Arrangement[]; writable: boolean } | null> => {
		const member = await getMember(ctx);
		if (!member) return null;
		const load = (workspaceId: Id<"workspaces"> | undefined, userId: Id<"users"> | undefined) => ctx.db.query("arrangements").withIndex("by_list", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId)).collect();
		const rows = (await Promise.all([load(member.workspaceId, undefined), load(member.workspaceId, member.userId), load(undefined, member.userId)])).flat();
		const seen = viewer(ctx, member);
		const shown: Arrangement[] = [];
		for (const { list, entityId, ids } of rows) {
			if (entityId && list === "pages" && !(await seen.pageLevel(entityId))) continue;
			const visible = await seen.filter(list, entityId, ids);
			if (visible) shown.push({ list, entityId, ids: visible });
		}
		return { rows: shown, writable: can(member, "sidebar.arrange") };
	},
});

function validate(ids: string[]) {
	if (ids.length > 4000 || ids.some((id) => !id || id.length > 256) || JSON.stringify(ids).length > 128_000) throw new ConvexError("Keep an arrangement under 4,000 ids and 128,000 characters.");
}

async function write(ctx: MutationCtx, place: Place, old: { _id: Id<"arrangements"> } | null, ids: string[]) {
	validate(ids);
	if (old) await ctx.db.patch(old._id, { ids });
	else await ctx.db.insert("arrangements", { ...place, ids });
}

const command = v.union(
	v.object({ op: v.union(v.literal("add"), v.literal("remove"), v.literal("visit")), id: v.string(), seed: v.optional(v.array(v.string())) }),
	v.object({ op: v.literal("move"), id: v.string(), beforeId: v.union(v.string(), v.null()), fill: v.optional(v.array(v.string())) }),
);

/**
 * One small change, applied to the whole stored list (core `applyCommand`), hidden ids included, so
 * someone who sees fewer items moves only theirs and the rest keep their order. The id it names and
 * its anchor must be live and visible to them: a hidden one fails just like a missing one.
 */
export const change = mutation({
	args: { ...targetArgs, command },
	handler: async (ctx, { command, ...target }) => {
		const member = await requireMember(ctx);
		if (arrangementLists[target.list].scope === "shared") checkPermission(member, "sidebar.arrange");
		const seen = viewer(ctx, member);
		const place = await placeOf(ctx, member, target, seen);
		if (!place) throw new ConvexError("Arrangement not found.");
		validate([command.id, ...extraIds(command)]);
		const columns = target.list === "columns" ? await columnsOf(ctx, target) : undefined;
		const shared = arrangementLists[target.list].scope === "shared";
		// Personal lists drop stale ids with a plain remove; on shared ones a hidden id can't be touched at all.
		const named = command.op === "move" && command.beforeId !== null ? [command.id, command.beforeId] : command.op === "remove" && !shared ? [] : [command.id];
		for (const id of named) if (!(await live(ctx, member, target, id, seen, columns))) throw new ConvexError("Not found.");
		const keep = async (ids?: string[]) => {
			if (!ids) return undefined;
			if (columns) return ids.filter((id) => columns.has(id));
			if (target.list === "views") { const views = await seen.views(target.entityId!); return ids.filter((id) => views.has(id)); }
			return shared ? (await seen.filter(target.list, target.entityId, ids)) ?? [] : ids.filter((id) => shaped(ctx, target.list, id));
		};
		const checked = command.op === "move" ? { ...command, fill: await keep(command.fill) } : { ...command, seed: await keep(command.seed) };
		const old = await rowOf(ctx, place);
		await write(ctx, place, old, applyCommand(old?.ids, checked));
	},
});

/** COMPAT(0.1.0-alpha.10): the legacy localStorage import reads at most this many ids… */
export const IMPORT_IDS_MAX = 100;
/** COMPAT(0.1.0-alpha.10): …and about this many bytes, then saves what it has, so every import finishes and the app clears its key. */
const IMPORT_BYTES_MAX = 8 * 1024 * 1024;

/**
 * COMPAT(0.1.0-alpha.10): one-time import of this computer's old arrangements (desktop `migrateArrangements`).
 * Delete it, `IMPORT_*`, `recordTypes.migrateDisplay`, the desktop importer and core `legacyArrangement` once
 * every install has run it. Imports name their destination before entity validation; the open workspace
 * is not authority. Bounded (`IMPORT_IDS_MAX`, `IMPORT_BYTES_MAX`): order past 100 items is dropped.
 */
export const migrate = mutation({
	args: { ...targetArgs, targetWorkspaceId: v.optional(v.string()), databaseKey: v.optional(v.string()), ids: v.array(v.string()) },
	handler: async (ctx, { targetWorkspaceId, databaseKey, ids, ...target }) => {
		const userId = await requireUserId(ctx);
		if (target.list === "recent") return;
		ids = [...new Set(ids)].slice(0, IMPORT_IDS_MAX);
		let workspaceId = targetWorkspaceId ? ctx.db.normalizeId("workspaces", targetWorkspaceId) : ctx.workspaceId;
		if (!targetWorkspaceId && target.list === "views" && target.entityId) {
			const typeId = ctx.db.normalizeId("recordTypes", target.entityId);
			workspaceId = typeId ? (await ctx.db.get(typeId))?.workspaceId : undefined;
		}
		const member = workspaceId && await memberOf(ctx, userId, workspaceId);
		if (!member || (arrangementLists[target.list].scope === "shared" && !can(member, "sidebar.arrange"))) return;
		if (databaseKey && target.list === "columns") {
			const type = await ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("key", databaseKey)).unique();
			if (!type) return;
			target.entityId = type._id;
		}
		const seen = viewer(ctx, member);
		const place = await placeOf(ctx, member, target, seen);
		// Never valid here (another workspace's page, a record's page, one they can't see): skip so the importer clears the key.
		if (!place) return;
		// Database order was stored as database keys on this computer.
		if (target.list === "databases") ids = (await Promise.all(ids.map((key) => ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("key", key)).unique()))).flatMap((type) => type ? [type._id] : []);
		validate(ids);
		if (await rowOf(ctx, place)) return;
		const columns = target.list === "columns" ? await columnsOf(ctx, target) : undefined;
		const budget = { bytes: IMPORT_BYTES_MAX };
		const read = reader(ctx, budget);
		const kept: string[] = [];
		for (const id of ids) {
			if (budget.bytes <= 0) break;
			if (await live(ctx, member, target, id, seen, columns, read)) kept.push(id);
		}
		await write(ctx, place, null, kept);
	},
});
