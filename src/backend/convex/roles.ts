import { type BuiltInRole, memberDefaults, switches } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Member, builtInRole, getMember, hasLiveOwner, requireInWorkspace, requirePermission, rolesOf } from "./lib";
import { permission } from "./schema";

// Roles (core permissions.ts): workspace data, so each company names its own ("Office", "Crew").
// Owner and Member are built in. Owner has every permission and can't change; Member is what new
// people get, and owners choose its switches like any other role's. Someone holding several roles
// gets every switch any of them has. Only owners shape roles (`roles.manage`); people with
// `members.manage` hand them out, except Owner.

/** Bounded, since every permission check reads them all (lib.ts memberOf). */
export const MAX_ROLES = 30;

/** Owner and Member, for a new workspace (and migrations.customRoles for old ones). */
export async function seedRoles(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
	const owner = await ctx.db.insert("roles", { workspaceId, name: "Owner", permissions: [], builtIn: "owner" });
	const member = await ctx.db.insert("roles", { workspaceId, name: "Member", permissions: memberDefaults, builtIn: "member" });
	return { owner, member };
}

/** Every role here, with how many people hold each. Everyone can see them: they're how refusals say who to ask. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return null;
		const held = new Map<Id<"roles">, number>();
		for await (const row of ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)))
			for (const id of row.roles ?? []) held.set(id, (held.get(id) ?? 0) + 1);
		return (await rolesOf(ctx, member.workspaceId)).map((r) => ({
			id: r._id,
			name: r.name,
			builtIn: r.builtIn ?? null,
			permissions: r.builtIn === "owner" ? switches : r.permissions,
			people: held.get(r._id) ?? 0,
		}));
	},
});

async function checkName(ctx: QueryCtx, workspaceId: Id<"workspaces">, name: string, except?: Id<"roles">) {
	const trimmed = name.trim();
	if (!trimmed) throw new ConvexError("Give the role a name.");
	if (trimmed.length > 40) throw new ConvexError("Keep the name under 40 characters.");
	const taken = (await rolesOf(ctx, workspaceId)).some((r) => r._id !== except && r.name.toLowerCase() === trimmed.toLowerCase());
	if (taken) throw new ConvexError(`There's already a role called ${trimmed}.`);
	return trimmed;
}

/** A role here that owners can change: anything but Owner. */
async function requireEditable(ctx: QueryCtx, member: Member, id: Id<"roles">) {
	const role = requireInWorkspace(member, await ctx.db.get(id), "Role");
	if (role.builtIn === "owner") throw new ConvexError("The Owner role can do everything and can't be changed.");
	return role;
}

/** A new role with no switches: people keep their other roles, so it only ever adds. Returns it. */
export const create = mutation({
	args: { name: v.string() },
	handler: async (ctx, { name }): Promise<Id<"roles">> => {
		const member = await requirePermission(ctx, "roles.manage");
		if ((await rolesOf(ctx, member.workspaceId)).length >= MAX_ROLES) throw new ConvexError(`A workspace can have up to ${MAX_ROLES} roles.`);
		return ctx.db.insert("roles", { workspaceId: member.workspaceId, name: await checkName(ctx, member.workspaceId, name), permissions: [] });
	},
});

export const rename = mutation({
	args: { id: v.id("roles"), name: v.string() },
	handler: async (ctx, { id, name }) => {
		const member = await requirePermission(ctx, "roles.manage");
		await requireEditable(ctx, member, id);
		await ctx.db.patch(id, { name: await checkName(ctx, member.workspaceId, name, id) });
	},
});

/** Turns one switch on or off. One at a time, so two owners editing at once never undo each other. Applies at once, mid-reply too. */
export const setPermission = mutation({
	args: { id: v.id("roles"), permission, on: v.boolean() },
	handler: async (ctx, args) => {
		const member = await requirePermission(ctx, "roles.manage");
		const role = await requireEditable(ctx, member, args.id);
		if (!switches.includes(args.permission)) throw new ConvexError("Only owners can do that; it isn't a switch.");
		const rest = role.permissions.filter((p) => p !== args.permission);
		await ctx.db.patch(role._id, { permissions: args.on ? [...rest, args.permission] : rest });
	},
});

/**
 * Deletes a role (not Owner or Member). People holding it lose it, and anyone left with no role gets
 * Member; invites likewise. Connectors stop allowing it.
 */
export const remove = mutation({
	args: { id: v.id("roles") },
	handler: async (ctx, { id }) => {
		const member = await requirePermission(ctx, "roles.manage");
		const role = await requireEditable(ctx, member, id);
		if (role.builtIn === "member") throw new ConvexError("Member is the role new people get, so it can't be deleted. Change its switches instead.");
		const fallback = (await builtInRole(ctx, member.workspaceId, "member"))._id;
		const without = (roles: Id<"roles">[]) => {
			const left = roles.filter((r) => r !== id);
			return left.length > 0 ? left : [fallback];
		};
		for await (const row of ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)))
			if (row.roles?.includes(id)) await ctx.db.patch(row._id, { roles: without(row.roles) });
		for await (const row of ctx.db.query("invites").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)))
			if (row.roles?.includes(id)) await ctx.db.patch(row._id, { roles: without(row.roles) });
		for await (const row of ctx.db.query("connectorInstalls").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)))
			if (row.roles.includes(id)) await ctx.db.patch(row._id, { roles: row.roles.filter((r) => r !== id) });
		await ctx.db.delete(id);
	},
});

/**
 * Role ids someone may hand out: this workspace's, at least one, no repeats. Only owners give
 * the Owner role, so `members.manage` alone can't make anyone an owner.
 */
export async function checkRoles(ctx: QueryCtx, member: Member, ids: Id<"roles">[]) {
	const roles = await rolesOf(ctx, member.workspaceId);
	const picked = [...new Set(ids)];
	if (picked.length === 0) throw new ConvexError("Pick at least one role.");
	if (picked.some((id) => !roles.some((r) => r._id === id))) throw new ConvexError("Role not found.");
	const owner = roles.find((r) => r.builtIn === "owner")!._id;
	if (picked.includes(owner) && !member.owner) throw new ConvexError("Only owners can make someone an owner.");
	return picked;
}

/** The ids of one of the built-in roles, for code that hands out a default. */
export const builtInId = async (ctx: QueryCtx, workspaceId: Id<"workspaces">, which: BuiltInRole) => (await builtInRole(ctx, workspaceId, which))._id;

/**
 * Gives someone exactly these roles. Taking Owner away (or giving it) is for owners only, and a
 * workspace always keeps one live owner. Takes effect at once, including for replies already running.
 */
export async function setMemberRoles(ctx: MutationCtx, member: Member, row: Doc<"members">, ids: Id<"roles">[]) {
	const owner = await builtInId(ctx, member.workspaceId, "owner");
	const wasOwner = !!row.roles?.includes(owner);
	if (wasOwner && !member.owner) throw new ConvexError("Only owners can change an owner's roles.");
	const picked = await checkRoles(ctx, member, ids);
	if (wasOwner && !picked.includes(owner) && !(await hasLiveOwner(ctx, member.workspaceId, row.userId))) throw new ConvexError("A workspace needs at least one owner.");
	await ctx.db.patch(row._id, { roles: picked });
}
