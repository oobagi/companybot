import { can } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, mutation, query } from "./_generated/server";
import { seedAgents } from "./agents";
import { addToChat, ensureGeneral } from "./chatOps";
import { checkVersion, getMember, namesOf, normalizeEmail, requirePermission } from "./lib";
import { role } from "./schema";

export const me = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		const user = userId ? await ctx.db.get(userId) : null;
		if (!user) return null;
		const member = await getMember(ctx);
		const workspace = member ? await ctx.db.get(member.workspaceId) : null;
		return { userId: user._id, email: user.email ?? "", role: member?.role ?? null, workspace: workspace?.name ?? null };
	},
});

/** Runs after sign-in: join an invited workspace, or start a new one as owner. */
export const ensure = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		if (await getMember(ctx)) return;

		const user = await ctx.db.get(userId);
		const email = normalizeEmail(user?.email ?? "");
		const invite = await ctx.db
			.query("invites")
			.withIndex("by_email", (q) => q.eq("email", email))
			.first();
		if (invite) {
			await ctx.db.insert("members", { workspaceId: invite.workspaceId, userId, role: invite.role });
			await ctx.db.delete(invite._id);
			await addToChat(ctx, await ensureGeneral(ctx, invite.workspaceId, userId), { userId });
			return;
		}

		const workspaceId = await ctx.db.insert("workspaces", { name: "My company", version: 1 });
		await ctx.db.insert("members", { workspaceId, userId, role: "owner" });
		await seedAgents(ctx, workspaceId, userId);
		await addToChat(ctx, await ensureGeneral(ctx, workspaceId, userId), { userId });
	},
});

export const team = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return null;
		const rows = await membersOf(ctx, member.workspaceId);
		const names = await namesOf(
			ctx,
			rows.map((r) => r.userId),
		);
		const members = await Promise.all(
			rows.map(async (r) => ({
				id: r._id,
				userId: r.userId,
				role: r.role,
				name: names.get(r.userId) ?? "",
				email: (await ctx.db.get(r.userId))?.email ?? "",
				isYou: r.userId === member.userId,
			})),
		);
		const invites =
			can(member.role, "members.manage")
				? (
						await ctx.db
							.query("invites")
							.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
							.collect()
					).map((i) => ({ id: i._id, email: i.email, role: i.role }))
				: [];
		return { members, invites };
	},
});

export const invite = mutation({
	args: { email: v.string(), role },
	handler: async (ctx, args) => {
		const { workspaceId } = await requirePermission(ctx, "members.manage");
		const email = normalizeEmail(args.email);
		if (!/^\S+@\S+\.\S+$/.test(email)) throw new ConvexError("That doesn't look like an email.");
		if (await isMemberEmail(ctx, workspaceId, email)) throw new ConvexError("That person is already a member.");
		const existing = await ctx.db
			.query("invites")
			.withIndex("by_email", (q) => q.eq("email", email))
			.first();
		if (existing) throw new ConvexError("That person already has an invite.");
		await ctx.db.insert("invites", { workspaceId, email, role: args.role });
	},
});

export const cancelInvite = mutation({
	args: { id: v.id("invites") },
	handler: async (ctx, { id }) => {
		const { workspaceId } = await requirePermission(ctx, "members.manage");
		const invite = await ctx.db.get(id);
		if (invite?.workspaceId === workspaceId) await ctx.db.delete(id);
	},
});

export const removeMember = mutation({
	args: { id: v.id("members") },
	handler: async (ctx, { id }) => {
		const owner = await requirePermission(ctx, "members.manage");
		const row = await ctx.db.get(id);
		if (!row || row.workspaceId !== owner.workspaceId) return;
		if (row.userId === owner.userId) throw new ConvexError("You can't remove yourself.");
		await ctx.db.delete(id);
	},
});

/** Takes effect at once, including for replies already running. */
export const setRole = mutation({
	args: { id: v.id("members"), role },
	handler: async (ctx, { id, role }) => {
		const owner = await requirePermission(ctx, "members.manage");
		const row = await ctx.db.get(id);
		if (!row || row.workspaceId !== owner.workspaceId) throw new ConvexError("Member not found.");
		if (row.role === "owner" && role !== "owner" && (await ownerCount(ctx, owner.workspaceId)) <= 1) {
			throw new ConvexError("A workspace needs at least one owner.");
		}
		await ctx.db.patch(id, { role });
	},
});

const membersOf = (ctx: QueryCtx, workspaceId: Id<"workspaces">) =>
	ctx.db
		.query("members")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();

async function ownerCount(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	return (await membersOf(ctx, workspaceId)).filter((r) => r.role === "owner").length;
}

/** Whether someone with this (normalized) email is already in the workspace. */
async function isMemberEmail(ctx: QueryCtx, workspaceId: Id<"workspaces">, email: string) {
	for (const row of await membersOf(ctx, workspaceId)) {
		const user = await ctx.db.get(row.userId);
		if (user?.email && normalizeEmail(user.email) === email) return true;
	}
	return false;
}

/** Shared workspace settings. */
export const settings = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		const workspace = member && (await ctx.db.get(member.workspaceId));
		return workspace ? { name: workspace.name, version: workspace.version ?? 0 } : null;
	},
});

export const updateSettings = mutation({
	args: { name: v.string(), expectedVersion: v.number() },
	handler: async (ctx, { name, expectedVersion }) => {
		const { workspaceId } = await requirePermission(ctx, "workspace.manage");
		const workspace = (await ctx.db.get(workspaceId))!;
		checkVersion(workspace.version ?? 0, expectedVersion);
		if (!name.trim()) throw new ConvexError("Name can't be empty.");
		await ctx.db.patch(workspaceId, { name: name.trim(), version: (workspace.version ?? 0) + 1 });
	},
});
