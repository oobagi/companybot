import { canEditMade } from "@companybot/core";
import { v } from "convex/values";
import { mutation, query } from "./functions";
import { getMember, requireMember, toActor } from "./lib";
import { createType, fieldsOf, liveTypesOf, setTypeTrashed, toField, updateType } from "./recordOps";

// Databases: the workspace's data model. Owners add types (`fields.manage`); fields
// are in fields.ts. See wiki/data.md.

/** Every live type, oldest first, with its fields in order, ones in Trash last and marked `archived`. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const actor = toActor(member);
		const types = await liveTypesOf(ctx, member.workspaceId);
		return Promise.all(
			types.map(async (t) => {
				const fields = await fieldsOf(ctx, t._id);
				return {
					_id: t._id,
					key: t.key,
					name: t.name,
					plural: t.plural,
					version: t.version ?? 0,
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
	// COMPAT(0.1.0-alpha.8): `name` is only sent by alpha.6 apps; newer ones send the plural alone.
	args: { plural: v.string(), name: v.optional(v.string()) },
	handler: async (ctx, input) => createType(ctx, { member: await requireMember(ctx) }, input),
});

export const update = mutation({
	// COMPAT(0.1.0-alpha.8): alpha.6 apps archive with `archived: true`; newer ones use trash.move.
	args: { typeId: v.id("recordTypes"), name: v.optional(v.string()), plural: v.optional(v.string()), archived: v.optional(v.boolean()), version: v.number() },
	handler: async (ctx, { typeId, archived, ...input }) => {
		const who = { member: await requireMember(ctx) };
		return archived === undefined ? updateType(ctx, who, typeId, input) : setTypeTrashed(ctx, who, typeId, archived);
	},
});
