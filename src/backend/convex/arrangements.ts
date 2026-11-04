import { arrangementScope } from "@companybot/core/arrangements";
import { can } from "@companybot/core/permissions";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { authUserId, checkPermission, getMember, memberOf, requireUserId } from "./lib";

type Place = { workspaceId?: Id<"workspaces">; userId?: Id<"users"> };

/** Resolve entity keys before reading or writing, including a page's sibling level. */
async function placeOf(ctx: QueryCtx, key: string, migrating = false): Promise<(Place & { writable: boolean }) | null> {
	const scope = arrangementScope(key);
	const userId = await authUserId(ctx);
	if (!scope || !userId) return null;
	if (scope === "account") return { userId, writable: true };
	let member = await getMember(ctx);
	const parts = key.split(":");
	if (parts.length > 1 && !key.startsWith("views.order:")) {
		const workspaceId = ctx.db.normalizeId("workspaces", parts[1]!);
		if (!workspaceId || (!migrating && workspaceId !== member?.workspaceId)) return null;
		member = await memberOf(ctx, userId, workspaceId);
	}
	if (key.startsWith("views.order:")) {
		const id = ctx.db.normalizeId("recordTypes", parts[1]!);
		const type = id && await ctx.db.get(id);
		if (!type || type.archived) return null;
		if (migrating) member = await memberOf(ctx, userId, type.workspaceId);
		if (type.workspaceId !== member?.workspaceId) return null;
	}
	if (!member) return null;
	if (key.startsWith("sidebar.pages:") && parts[2] !== "top") {
		const id = ctx.db.normalizeId("pages", parts[2]!);
		const page = id && await ctx.db.get(id);
		if (!page || page.archived || page.workspaceId !== member.workspaceId || page.recordId) return null;
	}
	if (key.startsWith("records.")) {
		const type = await ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("key", key.slice(key.indexOf(".", 8) + 1))).unique();
		if (!type || type.archived) return null;
	}
	return { workspaceId: member.workspaceId, userId: scope === "personal" ? userId : undefined, writable: scope === "personal" || can(member.role, "sidebar.arrange") };
}

const rowOf = (ctx: QueryCtx, place: Place, key: string) => ctx.db.query("arrangements").withIndex("by_key", (q) => q.eq("workspaceId", place.workspaceId).eq("userId", place.userId).eq("key", key)).unique();

function validate(key: string, ids: string[]) {
	if (ids.length > 4000 || ids.some((id) => !id || id.length > 256) || new Set(ids).size !== ids.length || JSON.stringify(ids).length > 128_000) throw new ConvexError("Keep an arrangement under 4,000 unique ids and 128,000 characters.");
	if (key.startsWith("records.layout.") && (ids.length > 2 || !["table", "board"].includes(ids[0] ?? ""))) throw new ConvexError("Choose a table or board layout.");
}

export const get = query({
	args: { key: v.string() },
	handler: async (ctx, { key }) => {
		const place = await placeOf(ctx, key);
		return { ids: place ? (await rowOf(ctx, place, key))?.ids ?? null : null, writable: place?.writable ?? false };
	},
});

async function save(ctx: MutationCtx, place: Place, key: string, ids: string[], onlyIfMissing: boolean) {
	const old = await rowOf(ctx, place, key);
	if (old) {
		if (!onlyIfMissing) await ctx.db.patch(old._id, { ids });
	} else await ctx.db.insert("arrangements", { workspaceId: place.workspaceId, userId: place.userId, key, ids });
}

export const set = mutation({
	args: { key: v.string(), ids: v.array(v.string()) },
	handler: async (ctx, { key, ids }) => {
		await requireUserId(ctx);
		const place = await placeOf(ctx, key);
		if (!place) throw new ConvexError("Arrangement not found.");
		if (!place.writable) checkPermission((await getMember(ctx))!, "sidebar.arrange");
		validate(key, ids);
		await save(ctx, place, key, ids, false);
	},
});

/** Missing entities and lost access discard old local keys. Import never overwrites another device. */
export const migrate = mutation({
	args: { key: v.string(), ids: v.array(v.string()) },
	handler: async (ctx, { key, ids }) => {
		await requireUserId(ctx);
		const place = await placeOf(ctx, key, true);
		if (!place?.writable) return;
		validate(key, ids);
		await save(ctx, place, key, ids, true);
	},
});
