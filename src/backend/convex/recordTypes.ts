import { canEditMade } from "@companybot/core";
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { ConvexError } from "convex/values";
import { databaseDisplay } from "./schema";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { Member } from "./lib";
import { checkPermission, getMember, requireMember, toActor } from "./lib";
import { createType, fieldsOf, requireType, toField, typesOf, updateType } from "./recordOps";

// Databases: the workspace's data model. Owners add types (`fields.manage`); fields
// are in fields.ts. See wiki/data.md.

/** Every live type, oldest first, with its fields in order, ones in Archive last and marked `archived`. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const actor = toActor(member);
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
						canEdit: canEditMade(actor, "fields.manage", f.createdBy),
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

async function saveDisplay(ctx: MutationCtx, member: Member, typeId: Id<"recordTypes">, display: { layout: "table" | "board"; groupBy?: string }, onlyIfMissing = false) {
	checkPermission(member, "sidebar.arrange");
	const type = await requireType(ctx, member, typeId, true);
	if (onlyIfMissing && type.display) return;
	if (display.groupBy) {
		const field = (await fieldsOf(ctx, typeId)).find((f) => f.key === display.groupBy && !f.archived);
		if (!field || field.kind !== "choice" || field.multiple) throw new ConvexError("Group a board by a live choice field that holds one option.");
	}
	await ctx.db.patch(typeId, { display });
}

export const setDisplay = mutation({
	args: { typeId: v.id("recordTypes"), display: databaseDisplay },
	handler: async (ctx, { typeId, display }) => saveDisplay(ctx, await requireMember(ctx), typeId, display),
});

export const migrateDisplay = mutation({
	args: { databaseKey: v.string(), display: databaseDisplay },
	handler: async (ctx, { databaseKey, display }) => {
		const member = await requireMember(ctx);
		const type = await ctx.db.query("recordTypes").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("key", databaseKey)).unique();
		if (type && !type.archived) await saveDisplay(ctx, member, type._id, display, true);
	},
});
