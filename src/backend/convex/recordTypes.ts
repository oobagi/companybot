import { can } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Member, getMember, requireMember, requirePermission } from "./lib";
import { createType, fieldsOf, requireType, toField, typesOf, updateType } from "./recordOps";
import { databaseDisplay } from "./schema";

// Databases: the workspace's data model. People with `fields.edit` add types; fields
// are in fields.ts. See wiki/data.md.

/** Every live type, oldest first, with its fields in order, ones in Archive last and marked `archived`. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const types = (await typesOf(ctx, member.workspaceId)).filter((t) => !t.archived).sort((a, b) => a._creationTime - b._creationTime);
		return Promise.all(
			types.map(async (t) => {
				const fields = await fieldsOf(ctx, t._id);
				return {
					_id: t._id,
					key: t.key,
					name: t.name,
					plural: t.plural,
					version: t.version ?? 0,
					display: t.display ?? { layout: "table" as const },
					fields: [...fields.filter((f) => !f.archived), ...fields.filter((f) => f.archived)].map((f) => ({
						_id: f._id,
						...toField(f),
						archived: f.archived,
						canEdit: can(member, "fields.edit"),
					})),
				};
			}),
		);
	},
});

export const create = mutation({
	args: { plural: v.string() },
	handler: async (ctx, input) => createType(ctx, { member: await requireMember(ctx) }, input),
});

export const update = mutation({
	args: { typeId: v.id("recordTypes"), name: v.optional(v.string()), plural: v.optional(v.string()), version: v.number() },
	handler: async (ctx, { typeId, ...input }) => updateType(ctx, { member: await requireMember(ctx) }, typeId, input),
});

type Display = { layout?: "table" | "board"; groupBy?: string };

/** Each change names only what it sets, so two people changing layout and grouping at once don't undo each other. */
async function saveDisplay(ctx: MutationCtx, member: Member, typeId: Id<"recordTypes">, change: Display) {
	const type = await requireType(ctx, member, typeId, true);
	if (change.groupBy && !(await groupable(ctx, typeId, change.groupBy))) throw new ConvexError("Group a board by a live choice field that holds one option.");
	const display = { layout: change.layout ?? type.display?.layout ?? "table", groupBy: change.groupBy ?? type.display?.groupBy };
	await ctx.db.patch(typeId, { display });
}

const groupable = async (ctx: MutationCtx, typeId: Id<"recordTypes">, key: string) => {
	const field = (await fieldsOf(ctx, typeId)).find((f) => f.key === key && !f.archived);
	return !!field && field.kind === "choice" && !field.multiple;
};

export const setDisplay = mutation({
	args: { typeId: v.id("recordTypes"), display: v.object({ layout: v.optional(databaseDisplay.fields.layout), groupBy: v.optional(v.string()) }) },
	handler: async (ctx, { typeId, display }) => saveDisplay(ctx, await requirePermission(ctx, "sidebar.arrange"), typeId, display),
});

/** One-time import of this computer's old choice. Anything that can never succeed is skipped, not thrown, so the importer can clear the key. */
export const migrateDisplay = mutation({
	args: { databaseKey: v.string(), display: databaseDisplay },
	handler: async (ctx, { databaseKey, display }) => {
		const member = await requireMember(ctx);
		if (!can(member, "sidebar.arrange")) return;
		const type = await ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("key", databaseKey)).unique();
		if (!type || type.archived || type.display) return;
		const groupBy = display.groupBy && (await groupable(ctx, type._id, display.groupBy)) ? display.groupBy : undefined;
		await ctx.db.patch(type._id, { display: { layout: display.layout, groupBy } });
	},
});
