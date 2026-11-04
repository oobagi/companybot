import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalMutation } from "./_generated/server";
import { setAgentTrashed } from "./agents";
import { canView } from "./automationOps";
import { removeInstall, setAutomationTrashed } from "./automations";
import { startCascade } from "./cascade";
import { canSee, setChannelTrashed } from "./chatOps";
import { mutation, query } from "./functions";
import { type Member, type Who, capped, checkPermission, emptyPage, getMember, requireMember } from "./lib";
import { deletePage, requirePage, setPageTrashed } from "./pageOps";
import { setFieldTrashed, setRecordTrashed, setTypeTrashed } from "./recordOps";
import { trashKind } from "./schema";
import { deleteMemory, setMemoryTrashed } from "./memoryOps";
import { setSkillTrashed } from "./skills";
import { type TrashKind, describeTrash, trashEntry } from "./trashOps";

// Archive uses the existing trash storage/API for installed-client compatibility.
// Items never expire. Owners may explicitly delete them forever.

const PAGE_MAX = 50;

const tables = {
	record: "records",
	database: "recordTypes",
	field: "recordFields",
	page: "pages",
	channel: "chats",
	agent: "agents",
	skill: "skillInstalls",
	automation: "automationInstalls",
	memory: "memories",
} as const satisfies Record<TrashKind, TableNames>;

function idOf<K extends TrashKind>(ctx: MutationCtx, kind: K, id: string) {
	const itemId = ctx.db.normalizeId(tables[kind], id);
	if (!itemId) throw new ConvexError("That isn't in this workspace.");
	return itemId as Id<(typeof tables)[K]>;
}

/** Moves an item to Archive, or back: each kind's own rules decide who may. Agents use the same. */
async function setTrashed(ctx: MutationCtx, who: Who, kind: TrashKind, id: string, trashed: boolean) {
	if (kind === "record") return void (await setRecordTrashed(ctx, who, idOf(ctx, kind, id), trashed));
	if (kind === "database") return setTypeTrashed(ctx, who, idOf(ctx, kind, id), trashed);
	if (kind === "field") return setFieldTrashed(ctx, who, idOf(ctx, kind, id), trashed);
	if (kind === "page") return setPageTrashed(ctx, who, await requirePage(ctx, who.member, idOf(ctx, kind, id)), trashed);
	if (kind === "agent") return setAgentTrashed(ctx, who, idOf(ctx, kind, id), trashed);
	if (kind === "skill") return setSkillTrashed(ctx, who, idOf(ctx, kind, id), trashed);
	if (kind === "automation") return setAutomationTrashed(ctx, who, idOf(ctx, kind, id), trashed);
	if (kind === "memory") return setMemoryTrashed(ctx, who, idOf(ctx, kind, id), trashed);
	return setChannelTrashed(ctx, who, idOf(ctx, kind, id), trashed);
}

/**
 * Deletes an entry's item for good. The entry goes at once, so it can't be restored; a cascade
 * (lifecycle.ts) then deletes what belonged to the item, and the item last. Pages, skills and
 * automations go at once (an automation's opt-ins and grants in its own cascade).
 */
async function deleteEntry(ctx: MutationCtx, entry: Doc<"trash">) {
	await ctx.db.delete(entry._id);
	const workspaceId = entry.workspaceId;
	if (entry.kind === "record") await startCascade(ctx, "record", { workspaceId, recordId: idOf(ctx, "record", entry.itemId) });
	if (entry.kind === "database") await startCascade(ctx, "database", { workspaceId, typeId: idOf(ctx, "database", entry.itemId) });
	if (entry.kind === "field") await startCascade(ctx, "field", { workspaceId, typeId: entry.typeId, fieldId: idOf(ctx, "field", entry.itemId) });
	if (entry.kind === "channel") await startCascade(ctx, "channel", { workspaceId, chatId: idOf(ctx, "channel", entry.itemId) });
	if (entry.kind === "page") await deletePage(ctx, idOf(ctx, "page", entry.itemId));
	if (entry.kind === "agent") await startCascade(ctx, "agent", { workspaceId, agentId: idOf(ctx, "agent", entry.itemId) });
	if (entry.kind === "skill") {
		const skill = await ctx.db.get(idOf(ctx, "skill", entry.itemId));
		if (skill) await ctx.db.delete(skill._id);
	}
	if (entry.kind === "automation") {
		const install = await ctx.db.get(idOf(ctx, "automation", entry.itemId));
		if (install) await removeInstall(ctx, install);
	}
	if (entry.kind === "memory") await deleteMemory(ctx, idOf(ctx, "memory", entry.itemId));
}

/** Trash never widens a private channel's or just-them automation's audience, including for workspace owners. */
async function visibleEntry(ctx: QueryCtx, member: Member, entry: Doc<"trash">) {
	if (entry.kind === "automation") {
		const id = ctx.db.normalizeId("automationInstalls", entry.itemId);
		const install = id && (await ctx.db.get(id));
		return !!install && canView(member, install);
	}
	if (entry.kind !== "channel") return true;
	const id = ctx.db.normalizeId("chats", entry.itemId);
	const chat = id && (await ctx.db.get(id));
	return !!chat && (await canSee(ctx, chat, member));
}

/** Skills and automations open by the id their screens use (custom or retained library), not their row's. */
async function screenIdOf(ctx: QueryCtx, entry: Doc<"trash">) {
	if (entry.kind === "skill") {
		const id = ctx.db.normalizeId("skillInstalls", entry.itemId);
		return (id && (await ctx.db.get(id))?.skillId) ?? null;
	}
	if (entry.kind === "automation") {
		const id = ctx.db.normalizeId("automationInstalls", entry.itemId);
		return (id && (await ctx.db.get(id))?.automationId) ?? null;
	}
	return null;
}

/** "Delete forever": owners only, and never agents. */
export async function purgeItem(ctx: MutationCtx, member: Member, itemId: string) {
	checkPermission(member, "trash.manage");
	const entry = await trashEntry(ctx, itemId);
	if (entry?.workspaceId !== member.workspaceId || !(await visibleEntry(ctx, member, entry))) throw new ConvexError("It's no longer in Archive.");
	await deleteEntry(ctx, entry);
}

/** What's in Archive, newest first, optionally one kind, or matching words in names (best first, up to 50). */
export const list = query({
	args: { kind: v.optional(trashKind), search: v.optional(v.string()), paginationOpts: paginationOptsValidator },
	handler: async (ctx, { kind, search, paginationOpts }) => {
		const member = await getMember(ctx);
		if (!member) return emptyPage();
		const opts = capped(paginationOpts, PAGE_MAX);
		const trash = ctx.db.query("trash");
		const result = search?.trim()
			? await trash
					.withSearchIndex("search", (q) => {
						const s = q.search("name", search).eq("workspaceId", member.workspaceId);
						return kind ? s.eq("kind", kind) : s;
					})
					.paginate(opts)
			: kind
				? await trash.withIndex("by_kind", (q) => q.eq("workspaceId", member.workspaceId).eq("kind", kind)).order("desc").paginate(opts)
				: await trash.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)).order("desc").paginate(opts);
		const page = [];
		for (const e of result.page) {
			if (!(await visibleEntry(ctx, member, e))) continue;
			const type = e.typeId && (await ctx.db.get(e.typeId));
			page.push({
				_id: e._id,
				...(await describeTrash(ctx, member, e)),
				in: type ? type.plural : null,
				typeKey: type ? type.key : null,
				screenId: await screenIdOf(ctx, e),
			});
		}
		return { ...result, page };
	},
});

const item = { kind: trashKind, id: v.string() };

/** "Delete": moves it to Archive. */
export const move = mutation({
	args: item,
	handler: async (ctx, { kind, id }) => setTrashed(ctx, { member: await requireMember(ctx) }, kind, id, true),
});

/** Puts it back where it was, links included. */
export const restore = mutation({
	args: item,
	handler: async (ctx, { kind, id }) => setTrashed(ctx, { member: await requireMember(ctx) }, kind, id, false),
});

/** "Delete forever". */
export const purge = mutation({
	args: { id: v.string() },
	handler: async (ctx, { id }) => purgeItem(ctx, await requireMember(ctx), id),
});

/** COMPAT: an already-scheduled Trash sweep must never expire archived content. */
export const sweep = internalMutation({
	args: {},
	handler: async () => {},
});
