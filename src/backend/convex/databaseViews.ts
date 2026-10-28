import { normalizeValue } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Member, type Who, checkPermission, checkVersion, getMember, requireInWorkspace, requireMember } from "./lib";
import { currencyOf, fieldsOf, logChange, requireType, toField } from "./recordOps";
import { validateView } from "./recordQuery";
import { viewConfig } from "./recordValidators";

// Shared database views. App and agent writes use the same validation and history.
const VIEWS_MAX = 50;
type Config = Pick<Doc<"databaseViews">, "name" | "filters" | "sort" | "columns" | "layout" | "groupBy">;

export async function viewsOf(ctx: QueryCtx, member: Member, typeId: Id<"recordTypes">) {
	await requireType(ctx, member, typeId, true);
	return ctx.db.query("databaseViews").withIndex("by_type", (q) => q.eq("typeId", typeId)).take(VIEWS_MAX);
}

export async function saveView(ctx: MutationCtx, who: Who, typeId: Id<"recordTypes">, input: Config, viewId?: Id<"databaseViews">, version?: number) {
	checkPermission(who.member, "records.edit");
	const views = await viewsOf(ctx, who.member, typeId);
	const old = viewId ? requireInWorkspace(who.member, await ctx.db.get(viewId), "View") : undefined;
	if (old && old.typeId !== typeId) throw new ConvexError("View not found.");
	if (old) checkVersion(old.version, version ?? -1);
	else if (views.length >= VIEWS_MAX) throw new ConvexError(`A database holds up to ${VIEWS_MAX} saved views.`);
	// Table is the default, so it isn't stored: views saved before boards stay unchanged.
	const config = { ...input, name: input.name.trim(), layout: input.layout === "board" ? input.layout : undefined };
	if (!config.name || config.name.length > 120) throw new ConvexError("Give the view a name, up to 120 characters.");
	if (views.some((v) => v._id !== viewId && v.name.toLowerCase() === config.name.toLowerCase())) throw new ConvexError("A view with that name already exists.");
	const fields = await fieldsOf(ctx, typeId);
	const live = fields.filter((f) => !f.archived).map((f) => f.key);
	if (!config.columns.includes("name") || new Set(config.columns).size !== config.columns.length || config.columns.some((k) => !live.includes(k)))
		throw new ConvexError("Pick live columns from this database, including Name, without duplicates.");
	const group = config.groupBy === undefined ? undefined : fields.find((f) => f.key === config.groupBy && !f.archived);
	if (config.groupBy !== undefined && (group?.kind !== "choice" || group.multiple)) throw new ConvexError("Group a board by a live choice field that holds one option.");
	const currency = await currencyOf(ctx, who.member.workspaceId);
	await validateView(ctx, fields, config.filters, config.sort, currency);
	config.filters = config.filters.map((c) => {
		const field = fields.find((f) => f.key === c.field)!;
		if (field.kind !== "choice") return c;
		const choice = (raw: unknown) => {
			const result = normalizeValue({ ...toField(field), multiple: false }, raw, "filter", currency);
			if ("error" in result) throw new ConvexError(result.error);
			return result.value;
		};
		return { ...c, ...(c.eq !== undefined && { eq: choice(c.eq) }), ...(c.in && { in: c.in.map(choice) }) };
	});
	if (JSON.stringify(config).length > 16_000) throw new ConvexError("Keep a saved view under 16,000 characters.");
	const text = (value: unknown) => (value === undefined || typeof value === "string" ? value : JSON.stringify(value));
	const changes = (["name", "filters", "sort", "columns", "layout", "groupBy"] as const)
		.filter((key) => text(old?.[key]) !== text(config[key]))
		.map((key) => ({ key, old: text(old?.[key]), new: text(config[key]) }));
	if (old && !changes.length) return old._id;
	const id = old ? old._id : await ctx.db.insert("databaseViews", { workspaceId: who.member.workspaceId, typeId, ...config, version: 1 });
	if (old) await ctx.db.patch(id, { ...config, version: old.version + 1 });
	await logChange(ctx, who, { typeId, subject: config.name, action: old ? "view.updated" : "view.created", changes });
	return id;
}

export async function deleteView(ctx: MutationCtx, who: Who, viewId: Id<"databaseViews">, version: number) {
	checkPermission(who.member, "records.edit");
	const view = requireInWorkspace(who.member, await ctx.db.get(viewId), "View");
	await viewsOf(ctx, who.member, view.typeId);
	checkVersion(view.version, version);
	await ctx.db.delete(viewId);
	await logChange(ctx, who, { typeId: view.typeId, subject: view.name, action: "view.deleted", changes: [{ key: "name", old: view.name }] });
}

export const list = query({
	args: { typeId: v.id("recordTypes") },
	handler: async (ctx, { typeId }) => {
		const member = await getMember(ctx);
		const type = member && (await ctx.db.get(typeId));
		return member && type?.workspaceId === member.workspaceId && !type.archived ? viewsOf(ctx, member, typeId) : [];
	},
});

export const save = mutation({
	args: { typeId: v.id("recordTypes"), viewId: v.optional(v.id("databaseViews")), version: v.optional(v.number()), ...viewConfig },
	handler: async (ctx, { typeId, viewId, version, ...config }) => {
		// COMPAT(0.1.0-alpha.8): alpha.7 apps don't send `layout`; keep a saved board's layout and grouping when they save it. Delete once installs send it.
		const old = config.layout === undefined && viewId ? await ctx.db.get(viewId) : null;
		const member = await requireMember(ctx);
		if (old) {
			requireInWorkspace(member, old, "View");
			const fields = await fieldsOf(ctx, typeId);
			const groupBy = fields.some((f) => f.key === old.groupBy && !f.archived && f.kind === "choice" && !f.multiple) ? old.groupBy : undefined;
			return saveView(ctx, { member }, typeId, { ...config, layout: old.layout, groupBy }, viewId, version);
		}
		return saveView(ctx, { member }, typeId, config, viewId, version);
	},
});

export const remove = mutation({
	args: { viewId: v.id("databaseViews"), version: v.number() },
	handler: async (ctx, { viewId, version }) => deleteView(ctx, { member: await requireMember(ctx) }, viewId, version),
});
