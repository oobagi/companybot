import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getMember, normalizeEmail, requireOwner } from "./lib";
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
			return;
		}

		const workspaceId = await ctx.db.insert("workspaces", { name: "My company" });
		await ctx.db.insert("members", { workspaceId, userId, role: "owner" });
	},
});

export const team = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return null;
		const rows = await ctx.db
			.query("members")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.collect();
		const members = await Promise.all(
			rows.map(async (r) => ({ id: r._id, userId: r.userId, role: r.role, email: (await ctx.db.get(r.userId))?.email ?? "" })),
		);
		const invites =
			member.role === "owner"
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
		const { workspaceId } = await requireOwner(ctx);
		const email = normalizeEmail(args.email);
		if (!/^\S+@\S+\.\S+$/.test(email)) throw new ConvexError("That doesn't look like an email.");
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
		const { workspaceId } = await requireOwner(ctx);
		const invite = await ctx.db.get(id);
		if (invite?.workspaceId === workspaceId) await ctx.db.delete(id);
	},
});

export const removeMember = mutation({
	args: { id: v.id("members") },
	handler: async (ctx, { id }) => {
		const owner = await requireOwner(ctx);
		const row = await ctx.db.get(id);
		if (!row || row.workspaceId !== owner.workspaceId) return;
		if (row.userId === owner.userId) throw new ConvexError("You can't remove yourself.");
		await ctx.db.delete(id);
	},
});

export const rename = mutation({
	args: { name: v.string() },
	handler: async (ctx, { name }) => {
		const { workspaceId } = await requireOwner(ctx);
		if (!name.trim()) throw new ConvexError("Name can't be empty.");
		await ctx.db.patch(workspaceId, { name: name.trim() });
	},
});
