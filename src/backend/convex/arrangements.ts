import { SECTION_ITEMS_MAX, applyCommand, arrangementLists, builtInSections, driveRowIds, extraIds, isPinKey, railTabs, type Arrangement, type ArrangementCommand, type ArrangementList, type SectionTab } from "@companybot/core/arrangements";
import { can } from "@companybot/core/permissions";
import { ConvexError, getDocumentSize, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canSee } from "./chatOps";
import { fileVisible } from "./driveFiles";
import { pageVisible } from "./pageOps";
import { chatAccess, reach } from "./placeAccess";
import { typesOf } from "./recordOps";
import { mutation, query } from "./functions";
import { type Member, checkPermission, getMember, memberOf, requireMember, requireUserId } from "./lib";
import { arrangementList } from "./schema";
import { sectionsOf } from "./sectionOps";

type Target = { list: ArrangementList; entityId?: string };
type Place = { workspaceId?: Id<"workspaces">; userId?: Id<"users">; list: ArrangementList; entityId?: Id<"pages"> | Id<"recordTypes"> };
const targetArgs = { list: arrangementList, entityId: v.optional(v.string()) };

/** A page level's ids read one by one (siblings under one parent): at most this many, the rest dropped from what's returned. */
export const PAGE_LEVEL_MAX = 500;
/** Page docs one call reads in all, levels, parents and their ancestors alike, so it stays under 4,096 index ranges. */
export const PAGE_READS_MAX = 2_000;
/** Channel ids one list resolves (each read directly, never a scan of the workspace); past either cap the rest are left out. */
export const CHANNEL_READS_MAX = 2_000;
const CHANNEL_BYTES_MAX = 8 * 1024 * 1024;

/** Thrown when a call has read `PAGE_READS_MAX` pages: `get` leaves that level out. */
class OutOfPageReads extends Error {}

/**
 * What of each list someone may see, so nobody receives or moves an id they can't see. Channels and
 * databases take two and one indexed reads in all (channels capped); pages go through one cached,
 * budgeted reader shared by levels, parents and ancestors. Personal lists pass through.
 */
export function viewer(ctx: QueryCtx, member: Member) {
	// Channels: each stored id read directly (cached, ~8 MiB in all), checked against the caller's seats
	// (one indexed read) and the channel's own privacy and Who can access list. `get`, commands and `fill` share it.
	const seats = once(async () => new Set<string>((await ctx.db.query("chatMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("userId", member.userId)).collect()).map((s) => s.chatId)));
	const channelSeen = new Map<string, Promise<boolean>>();
	let channelBytes = CHANNEL_BYTES_MAX;
	const channel = (id: string) => {
		let seen = channelSeen.get(id);
		if (!seen) channelSeen.set(id, (seen = (async () => {
			const chatId = ctx.db.normalizeId("chats", id);
			if (!chatId || channelBytes <= 0) return false;
			const c = await ctx.db.get(chatId);
			if (!c) return false;
			channelBytes -= getDocumentSize(c);
			return c.workspaceId === member.workspaceId && c.kind === "channel" && !c.archived && (!c.private || (await seats()).has(c._id)) && !!reach(member, chatAccess(c));
		})()));
		return seen;
	};
	const channels = async (ids: string[]) => {
		const kept: string[] = [];
		for (const id of ids.slice(0, CHANNEL_READS_MAX)) if (await channel(id)) kept.push(id);
		return kept;
	};
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
	const fileSeen = fileVisible(ctx, member);
	const file = async (id: string) => {
		const fileId = ctx.db.normalizeId("driveFiles", id);
		const doc = fileId && await ctx.db.get(fileId);
		return !!doc && doc.workspaceId === member.workspaceId && !doc.archived && await fileSeen(doc) ? doc : null;
	};
	/** A Drive row this person sees: a page, folder or file (a level's order and a section hold all three). */
	const driveItem = (id: string) => (ctx.db.normalizeId("driveFiles", id) ? file(id) : page(id));
	const sections = once(() => sectionsOf(ctx, member.workspaceId));
	/** Whether a section can hold this and the person sees it: a channel, a database, or a top-level page, folder or file. */
	const sectionItem = async (tab: SectionTab, id: string) => {
		if (tab === "chat") return channel(id);
		if (tab === "databases") return (await types()).has(id);
		const doc = await driveItem(id);
		return !!doc && !doc.parentId;
	};
	const viewsOf = async (typeId: string) => {
		const id = ctx.db.normalizeId("recordTypes", typeId);
		if (!id || !(await types()).has(id)) return new Set<string>();
		const views = await ctx.db.query("databaseViews").withIndex("by_type", (q) => q.eq("typeId", id)).collect();
		return new Set<string>(views.filter((view) => view.workspaceId === member.workspaceId).map((view) => view._id));
	};
	return {
		page,
		file,
		channel,
		/** Whether a page level's parent is visible; a call out of page reads can't tell, so it leaves the level out. */
		pageLevel: async (parentId: string) => { try { return !!(await page(parentId)); } catch (e) { if (e instanceof OutOfPageReads) return false; throw e; } },
		database: async (id: string) => (await types()).has(id),
		section: async (id: string) => (await sections()).find((s) => s._id === id),
		sections,
		sectionItem,
		/** What of a section this person sees, in order. Out of page reads, the rest is left out. */
		sectionIds: async (tab: SectionTab, ids: string[]) => {
			const kept: string[] = [];
			try {
				for (const id of ids.slice(0, SECTION_ITEMS_MAX)) if (await sectionItem(tab, id)) kept.push(id);
			} catch (e) {
				if (!(e instanceof OutOfPageReads)) throw e;
			}
			return kept;
		},
		/** The ids of a list this person may see, in order. Null: the whole list is hidden from them (or out of reads). */
		filter: async (list: ArrangementList, entityId: string | undefined, ids: string[]): Promise<string[] | null> => {
			switch (list) {
				case "channels": case "channelFolds": return channels(ids);
				case "databases": { const seen = await types(); return ids.filter((id) => seen.has(id)); }
				case "sectionOrder": { const all = new Set<string>((await sections()).map((s) => s._id)); return ids.filter((id) => all.has(id)); }
				case "views": case "columns": return (await types()).has(entityId!) ? ids : null;
				case "pages": {
					const kept: string[] = [];
					try {
						for (const id of ids.slice(0, PAGE_LEVEL_MAX)) if (await driveItem(id)) kept.push(id);
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
export type Viewer = ReturnType<typeof viewer>;

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
type Read = <T extends "chats" | "pages" | "databaseViews" | "agents" | "driveFiles">(table: T, id: string) => Promise<Doc<T> | null>;
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
			// The shared resolver, with its own ~8 MiB budget (the import's included).
			return seen.channel(id);
		}
		case "pages": case "expanded": {
			// A level's order holds its files too, read directly like a section's.
			if (target.list === "pages" && ctx.db.normalizeId("driveFiles", id)) {
				const file = await read("driveFiles", id);
				return !!file && !file.archived && file.workspaceId === member.workspaceId && (file.parentId ?? undefined) === target.entityId && !!(await seen.file(id));
			}
			const page = await read("pages", id);
			return !!page && !page.archived && !page.recordId && page.workspaceId === member.workspaceId && (target.list === "expanded" || (page.parentId ?? undefined) === target.entityId) && !!await seen.page(id);
		}
		case "views": {
			const view = await read("databaseViews", id);
			return !!view && view.workspaceId === member.workspaceId && view.typeId === target.entityId;
		}
		case "databases": return seen.database(id);
		case "sectionOrder": return !!(await seen.section(id));
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
		case "folded": return builtInSections.includes(id) || !!ctx.db.normalizeId("sidebarSections", id);
		case "rail": return railTabs.includes(id) || isPinKey(id);
		case "driveRows": return driveRowIds.includes(id);
		default: return true;
	}
}

/** A sidebar section as the app gets it: what it holds, cut to what this person sees. */
export type Section = { _id: Id<"sidebarSections">; tab: SectionTab; name: string; ids: string[] };

/**
 * Every list the open workspace has for this person, cut to what they may see (`viewer`): stored ids,
 * never one read per channel. A list whose page or database they can't open is left out. With them,
 * the sidebar's sections (sidebarSections.ts), so a tab's layout loads in one piece.
 */
export const get = query({
	args: {},
	handler: async (ctx): Promise<{ rows: Arrangement[]; sections: Section[]; writable: boolean } | null> => {
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
		const sections: Section[] = [];
		for (const { _id, tab, name, ids } of await seen.sections()) sections.push({ _id, tab, name, ids: await seen.sectionIds(tab, ids) });
		return { rows: shown, sections, writable: can(member, "sidebar.arrange") };
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
	handler: async (ctx, { command, ...target }) => changeArrangement(ctx, await requireMember(ctx), target, command),
});

/** `change`, for a mutation that moves something between lists (sidebarSections.place). */
export async function changeArrangement(ctx: MutationCtx, member: Member, target: Target, command: ArrangementCommand, seen = viewer(ctx, member)) {
	if (arrangementLists[target.list].scope === "shared") checkPermission(member, "sidebar.arrange");
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
}

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
