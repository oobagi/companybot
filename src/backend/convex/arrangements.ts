import { applyCommand, arrangementLists, extraIds, railTabs, sidebarSections, type Arrangement, type ArrangementList } from "@companybot/core/arrangements";
import { can } from "@companybot/core/permissions";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { canSee } from "./chatOps";
import { mutation, query } from "./functions";
import { type Member, checkPermission, getMember, memberOf, requireMember, requireUserId } from "./lib";
import { arrangementList } from "./schema";

type Target = { list: ArrangementList; entityId?: string };
type Place = { workspaceId?: Id<"workspaces">; userId?: Id<"users">; list: ArrangementList; entityId?: Id<"pages"> | Id<"recordTypes"> };
const targetArgs = { list: arrangementList, entityId: v.optional(v.string()) };

async function placeOf(ctx: QueryCtx, member: Member, target: Target): Promise<Place | null> {
	const definition = arrangementLists[target.list];
	let entityId: Place["entityId"];
	if (definition.entity) {
		if (target.entityId) {
			const id = ctx.db.normalizeId(definition.entity, target.entityId);
			const entity = id && await ctx.db.get(id);
			if (!entity || entity.archived || entity.workspaceId !== member.workspaceId || ("recordId" in entity && entity.recordId)) return null;
			entityId = entity._id;
		} else if (target.list !== "pages") return null;
	} else if (target.entityId) return null;
	return { list: target.list, entityId, workspaceId: definition.scope === "account" ? undefined : member.workspaceId, userId: definition.scope === "shared" ? undefined : member.userId };
}
const rowOf = (ctx: QueryCtx, place: Place) => ctx.db.query("arrangements").withIndex("by_list", (q) => q.eq("workspaceId", place.workspaceId).eq("userId", place.userId).eq("list", place.list).eq("entityId", place.entityId)).unique();

async function channelOf(ctx: QueryCtx, member: Member, id: string) {
	const chatId = ctx.db.normalizeId("chats", id);
	const chat = chatId && await ctx.db.get(chatId);
	return chat && !chat.archived && chat.workspaceId === member.workspaceId && chat.kind === "channel" ? chat : null;
}

const columnsOf = async (ctx: QueryCtx, target: Target) => {
	const typeId = ctx.db.normalizeId("recordTypes", target.entityId!)!;
	const fields = await ctx.db.query("recordFields").withIndex("by_type", (q) => q.eq("typeId", typeId)).collect();
	return new Set(fields.filter((f) => !f.archived).map((f) => f.key));
};

/** Whether one id is something live this list can hold: one to three reads, so only for the id a command names. */
async function live(ctx: QueryCtx, member: Member, target: Target, id: string, columns?: Set<string>) {
	switch (target.list) {
		case "channels": case "channelFolds": return !!await channelOf(ctx, member, id);
		case "pages": case "expanded": {
			const pageId = ctx.db.normalizeId("pages", id);
			const page = pageId && await ctx.db.get(pageId);
			return !!page && !page.archived && !page.recordId && page.workspaceId === member.workspaceId && (target.list === "expanded" || (page.parentId ?? undefined) === target.entityId);
		}
		case "views": {
			const viewId = ctx.db.normalizeId("databaseViews", id);
			const view = viewId && await ctx.db.get(viewId);
			return !!view && view.workspaceId === member.workspaceId && view.typeId === target.entityId;
		}
		case "databases": {
			const typeId = ctx.db.normalizeId("recordTypes", id);
			const type = typeId && await ctx.db.get(typeId);
			return !!type && !type.archived && type.workspaceId === member.workspaceId;
		}
		case "dms": case "dmFolds": {
			const agentId = ctx.db.normalizeId("agents", id);
			const chatId = ctx.db.normalizeId("chats", id);
			const agent = agentId && await ctx.db.get(agentId);
			const chat = chatId && await ctx.db.get(chatId);
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

/** Whether an id could belong in this list, without reading it: for `fill` and `seed`, which can name a whole list. */
function shaped(ctx: QueryCtx, list: ArrangementList, id: string) {
	switch (list) {
		case "channels": case "channelFolds": return !!ctx.db.normalizeId("chats", id);
		case "pages": case "expanded": return !!ctx.db.normalizeId("pages", id);
		case "views": return !!ctx.db.normalizeId("databaseViews", id);
		case "databases": return !!ctx.db.normalizeId("recordTypes", id);
		case "dms": case "dmFolds": return !!(ctx.db.normalizeId("agents", id) || ctx.db.normalizeId("chats", id));
		case "workspaces": return !!ctx.db.normalizeId("workspaces", id);
		case "sections": case "folded": return sidebarSections.includes(id);
		case "tabs": return railTabs.includes(id);
		default: return true;
	}
}

/** Stored ids as saved: no per-id reads, so it doesn't rerun on every message. Clients drop ids they don't have. */
export const get = query({
	args: {},
	handler: async (ctx): Promise<{ rows: Arrangement[]; writable: boolean } | null> => {
		const member = await getMember(ctx);
		if (!member) return null;
		const load = (workspaceId: Id<"workspaces"> | undefined, userId: Id<"users"> | undefined) => ctx.db.query("arrangements").withIndex("by_list", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId)).collect();
		const rows = (await Promise.all([load(member.workspaceId, undefined), load(member.workspaceId, member.userId), load(undefined, member.userId)])).flat();
		return { rows: rows.map(({ list, entityId, ids }) => ({ list, entityId, ids })), writable: can(member, "sidebar.arrange") };
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

/** One small change, applied to the current list (core `applyCommand`). Only the id it names is read. */
export const change = mutation({
	args: { ...targetArgs, command },
	handler: async (ctx, { command, ...target }) => {
		const member = await requireMember(ctx);
		if (arrangementLists[target.list].scope === "shared") checkPermission(member, "sidebar.arrange");
		const place = await placeOf(ctx, member, target);
		if (!place) throw new ConvexError("Arrangement not found.");
		const extra = extraIds(command);
		validate([command.id, ...extra]);
		const columns = target.list === "columns" ? await columnsOf(ctx, target) : undefined;
		// Something deleted since the click: nothing to add or move.
		if (command.op !== "remove" && !(await live(ctx, member, target, command.id, columns))) return;
		const keep = (ids?: string[]) => ids?.filter((id) => columns ? columns.has(id) : shaped(ctx, target.list, id));
		const checked = command.op === "move" ? { ...command, fill: keep(command.fill) } : { ...command, seed: keep(command.seed) };
		const old = await rowOf(ctx, place);
		await write(ctx, place, old, applyCommand(old?.ids, checked));
	},
});

/** Imports name their destination before entity validation; the open workspace is not authority. */
export const migrate = mutation({
	args: { ...targetArgs, targetWorkspaceId: v.optional(v.string()), databaseKey: v.optional(v.string()), ids: v.array(v.string()) },
	handler: async (ctx, { targetWorkspaceId, databaseKey, ids, ...target }) => {
		const userId = await requireUserId(ctx);
		if (target.list === "recent") return;
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
		const entityTable = arrangementLists[target.list].entity;
		if (entityTable && target.entityId) {
			const entityId = ctx.db.normalizeId(entityTable, target.entityId);
			const entity = entityId && await ctx.db.get(entityId);
			if (!entity || entity.archived) return;
		}
		const place = await placeOf(ctx, member, target);
		// Never valid here (another workspace's page, a record's page): skip so the importer clears the key.
		if (!place) return;
		// Database order was stored as database keys on this computer.
		if (target.list === "databases") ids = (await Promise.all(ids.map((key) => ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("key", key)).unique()))).flatMap((type) => type ? [type._id] : []);
		validate(ids);
		if (await rowOf(ctx, place)) return;
		const columns = target.list === "columns" ? await columnsOf(ctx, target) : undefined;
		const kept: string[] = [];
		for (const id of new Set(ids)) if (await live(ctx, member, target, id, columns)) kept.push(id);
		await write(ctx, place, null, kept);
	},
});
