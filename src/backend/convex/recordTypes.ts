import { canEditMade } from "@companybot/core";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getMember, requireMember, toActor } from "./lib";
import { createType, fieldsOf, toField, typesOf } from "./recordOps";

// Record types: the workspace's data model. Owners add types (`fields.manage`); fields
// are in fields.ts. See wiki/data.md.

/** Every live type, oldest first, with its fields in order, archived fields last and marked. The data model agents read. */
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
	args: { name: v.string(), plural: v.string() },
	handler: async (ctx, input) => createType(ctx, { member: await requireMember(ctx) }, input),
});
