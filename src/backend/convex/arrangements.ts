import { arrangementLists, railTabs, sidebarSections, type Arrangement, type ArrangementList } from "@companybot/core/arrangements";
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

/** Prune on every save so removed things cannot accumulate in navigation lists. */
async function prune(ctx: QueryCtx, member: Member, target: Target, ids: string[]) {
	const kept: string[] = [];
	let columns: Set<string> | undefined;
	if (target.list === "columns") {
		const typeId = ctx.db.normalizeId("recordTypes", target.entityId!)!;
		const fields = await ctx.db.query("recordFields").withIndex("by_type", (q) => q.eq("typeId", typeId)).collect();
		columns = new Set(fields.filter((f) => !f.archived).map((f) => f.key));
	}
	for (const id of new Set(ids)) {
		let live = true;
		switch (target.list) {
			case "channels": case "channelFolds": live = !!await channelOf(ctx, member, id); break;
			case "pages": case "expanded": {
				const pageId = ctx.db.normalizeId("pages", id);
				const page = pageId && await ctx.db.get(pageId);
				live = !!page && !page.archived && !page.recordId && page.workspaceId === member.workspaceId && (target.list === "expanded" || (page.parentId ?? undefined) === target.entityId);
				break;
			}
			case "views": {
				const viewId = ctx.db.normalizeId("databaseViews", id);
				const view = viewId && await ctx.db.get(viewId);
				live = !!view && view.workspaceId === member.workspaceId && view.typeId === target.entityId;
				break;
			}
			case "databases": {
				const typeId = ctx.db.normalizeId("recordTypes", id);
				const type = typeId && await ctx.db.get(typeId);
				live = !!type && !type.archived && type.workspaceId === member.workspaceId;
				break;
			}
			case "dms": case "dmFolds": {
				const agentId = ctx.db.normalizeId("agents", id);
				const chatId = ctx.db.normalizeId("chats", id);
				const agent = agentId && await ctx.db.get(agentId);
				const chat = chatId && await ctx.db.get(chatId);
				live = !!(agent && !agent.archived && agent.workspaceId === member.workspaceId) || !!(chat && !chat.archived && chat.kind === "dm" && await canSee(ctx, chat, member));
				break;
			}
			case "sections": case "folded": live = sidebarSections.includes(id); break;
			case "tabs": live = railTabs.includes(id); break;
			case "columns": live = columns!.has(id); break;
			case "workspaces": {
				const ws = ctx.db.normalizeId("workspaces", id);
				live = !!ws && !!await memberOf(ctx, member.userId, ws);
			}
		}
		if (live) kept.push(id);
	}
	return kept;
}

async function visibleChannels(ctx: QueryCtx, member: Member, ids: string[]) {
	const visible: string[] = [];
	for (const id of ids) {
		const chat = await channelOf(ctx, member, id);
		if (chat && await canSee(ctx, chat, member)) visible.push(id);
	}
	return visible;
}

export const get = query({
	args: {},
	handler: async (ctx): Promise<{ rows: Arrangement[]; writable: boolean } | null> => {
		const member = await getMember(ctx);
		if (!member) return null;
		const load = (workspaceId: Id<"workspaces"> | undefined, userId: Id<"users"> | undefined) => ctx.db.query("arrangements").withIndex("by_list", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId)).collect();
		const rows = (await Promise.all([load(member.workspaceId, undefined), load(member.workspaceId, member.userId), load(undefined, member.userId)])).flat();
		return {
			rows: await Promise.all(rows.map(async ({ list, entityId, ids }) => ({ list, entityId, ids: list === "channels" ? await visibleChannels(ctx, member, ids) : ids }))),
			writable: can(member, "sidebar.arrange"),
		};
	},
});

function validate(ids: string[]) {
	if (ids.length > 4000 || ids.some((id) => !id || id.length > 256) || JSON.stringify(ids).length > 128_000) throw new ConvexError("Keep an arrangement under 4,000 ids and 128,000 characters.");
}

async function save(ctx: MutationCtx, member: Member, place: Place, ids: string[], onlyIfMissing: boolean) {
	const old = await rowOf(ctx, place);
	if (onlyIfMissing && old) return;
	let kept = await prune(ctx, member, place, ids);
	if (place.list === "channels") {
		const visible = new Set(await visibleChannels(ctx, member, kept));
		const before = await prune(ctx, member, place, old?.ids ?? []);
		const beforeVisible = new Set(await visibleChannels(ctx, member, before));
		const hidden = new Set(before.filter((id) => !beforeVisible.has(id)));
		// Reads omit private channels. Keep their slots when someone reorders visible ones.
		const next = kept.filter((id) => visible.has(id));
		kept = before.flatMap((id) => hidden.has(id) ? [id] : next.length ? [next.shift()!] : []);
		kept.push(...next);
	}
	validate(kept);
	if (old) await ctx.db.patch(old._id, { ids: kept });
	else await ctx.db.insert("arrangements", { ...place, ids: kept });
}

export const set = mutation({
	args: { ...targetArgs, ids: v.array(v.string()) },
	handler: async (ctx, { ids, ...target }) => {
		const member = await requireMember(ctx);
		if (arrangementLists[target.list].scope === "shared") checkPermission(member, "sidebar.arrange");
		const place = await placeOf(ctx, member, target);
		if (!place) throw new ConvexError("Arrangement not found.");
		validate(ids);
		await save(ctx, member, place, ids, false);
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
		await save(ctx, member, place, ids, true);
	},
});
