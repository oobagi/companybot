import { fireEvent } from "./automations";
import { DEFAULT_CURRENCY, can, isCurrencyCode } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, mutation, query } from "./_generated/server";
import { seedAgents } from "./agents";
import { fieldsOf, seedRecordTypes, typesOf } from "./recordOps";
import { addToChat, ensureGeneral } from "./chatOps";
import { sendInviteEmail } from "./invites";
import { checkVersion, getMember, memberOf, nameOf, namesOf, normalizeEmail, requireMember, requirePermission, timeZoneOf } from "./lib";
import { forgetUserRules } from "./permissions";
import { role } from "./schema";

export const me = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		const user = userId ? await ctx.db.get(userId) : null;
		if (!user) return null;
		const member = await getMember(ctx);
		const workspace = member ? await ctx.db.get(member.workspaceId) : null;
		return {
			userId: user._id,
			email: user.email ?? "",
			role: member?.role ?? null,
			workspace: workspace?.name ?? null,
			workspaceId: workspace?._id ?? null,
		};
	},
});

/** Runs after sign-in. Someone new joins every workspace that invited them, or starts one as owner. */
export const ensure = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		if (await getMember(ctx)) return;

		const invites = await invitesFor(ctx, userId);
		for (const invite of invites) await join(ctx, invite, userId);
		if (invites.length > 0) return;

		const workspaceId = await ctx.db.insert("workspaces", { name: "My company", version: 1 });
		await ctx.db.insert("members", { workspaceId, userId, role: "owner" });
		await seedAgents(ctx, workspaceId, userId);
		await seedRecordTypes(ctx, workspaceId, userId);
		await addToChat(ctx, await ensureGeneral(ctx, workspaceId, userId), { userId });
	},
});

/** Pending invites to this person's (verified) email. */
async function invitesFor(ctx: QueryCtx, userId: Id<"users">) {
	const email = normalizeEmail((await ctx.db.get(userId))?.email ?? "");
	if (!email) return [];
	return ctx.db
		.query("invites")
		.withIndex("by_email", (q) => q.eq("email", email))
		.collect();
}

/** Uses up an invite: they're in, in #general, with that workspace open. */
async function join(ctx: MutationCtx, invite: Doc<"invites">, userId: Id<"users">) {
	await ctx.db.delete(invite._id);
	if (await memberOf(ctx, userId, invite.workspaceId)) return;
	await ctx.db.insert("members", { workspaceId: invite.workspaceId, userId, role: invite.role });
	await addToChat(ctx, await ensureGeneral(ctx, invite.workspaceId, userId), { userId });
	await openWorkspace(ctx, userId, invite.workspaceId);
	await fireEvent(ctx, invite.workspaceId, "member.joined", {
		data: { name: await nameOf(ctx, userId), email: invite.email, role: invite.role },
	});
}

async function openWorkspace(ctx: MutationCtx, userId: Id<"users">, workspaceId: Id<"workspaces">) {
	const prefs = await ctx.db
		.query("preferences")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.first();
	if (prefs) await ctx.db.patch(prefs._id, { workspaceId });
	else await ctx.db.insert("preferences", { userId, displayName: "", sendWith: "enter", workspaceId });
}

/** The workspaces you're in, and invites waiting for you, for the workspace menu. */
export const mine = query({
	args: {},
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		const open = await getMember(ctx);
		if (!userId || !open) return null;
		const rows = await ctx.db
			.query("members")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect();
		const workspaces = [];
		for (const row of rows) {
			const workspace = await ctx.db.get(row.workspaceId);
			if (workspace) workspaces.push({ id: workspace._id, name: workspace.name, role: row.role, open: workspace._id === open.workspaceId });
		}
		const invitations = [];
		for (const invite of await invitesFor(ctx, userId)) {
			const workspace = await ctx.db.get(invite.workspaceId);
			if (!workspace) continue;
			invitations.push({
				id: invite._id,
				workspace: workspace.name,
				role: invite.role,
				invitedBy: invite.invitedBy ? await nameOf(ctx, invite.invitedBy) : null,
			});
		}
		return { workspaces: workspaces.sort((a, b) => a.name.localeCompare(b.name)), invitations };
	},
});

/** Opens another workspace you're in. It stays open on your other devices too. */
export const switchTo = mutation({
	args: { workspaceId: v.id("workspaces") },
	handler: async (ctx, { workspaceId }) => {
		const userId = await getAuthUserId(ctx);
		if (!userId || !(await memberOf(ctx, userId, workspaceId))) throw new ConvexError("You're not in that workspace.");
		await openWorkspace(ctx, userId, workspaceId);
	},
});

/** An invite to your own email, so nobody can use one meant for someone else. */
async function requireMyInvite(ctx: QueryCtx, id: Id<"invites">) {
	const userId = await getAuthUserId(ctx);
	const invite = userId && (await invitesFor(ctx, userId)).find((i) => i._id === id);
	if (!userId || !invite) throw new ConvexError("That invite isn't available anymore.");
	return { userId, invite };
}

export const acceptInvite = mutation({
	args: { id: v.id("invites") },
	handler: async (ctx, { id }) => {
		const { userId, invite } = await requireMyInvite(ctx, id);
		await join(ctx, invite, userId);
	},
});

export const declineInvite = mutation({
	args: { id: v.id("invites") },
	handler: async (ctx, { id }) => {
		const { invite } = await requireMyInvite(ctx, id);
		await ctx.db.delete(invite._id);
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
				/** For profiles: the zone they picked, else their computer's. */
				timeZone: await timeZoneOf(ctx, r.userId),
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

/** Owners only. Emails them a link to the app; they join when they sign in with that email. */
export const invite = mutation({
	args: { email: v.string(), role },
	handler: async (ctx, args) => {
		const { workspaceId, userId } = await requirePermission(ctx, "members.manage");
		const email = normalizeEmail(args.email);
		if (!/^\S+@\S+\.\S+$/.test(email)) throw new ConvexError("That doesn't look like an email.");
		if (await isMemberEmail(ctx, workspaceId, email)) throw new ConvexError("That person is already a member.");
		if (await inviteIn(ctx, workspaceId, email)) throw new ConvexError("That person already has an invite.");
		const id = await ctx.db.insert("invites", { workspaceId, email, role: args.role, invitedBy: userId });
		await sendInviteEmail(ctx, (await ctx.db.get(id))!, userId);
	},
});

/** Sends the invite email again. Limited, so nobody's inbox gets flooded. */
export const resendInvite = mutation({
	args: { id: v.id("invites") },
	handler: async (ctx, { id }) => {
		const { workspaceId, userId } = await requirePermission(ctx, "members.manage");
		const invite = await ctx.db.get(id);
		if (invite?.workspaceId !== workspaceId) throw new ConvexError("That invite isn't available anymore.");
		await sendInviteEmail(ctx, invite, userId, { resend: true });
	},
});

const inviteIn = (ctx: QueryCtx, workspaceId: Id<"workspaces">, email: string) =>
	ctx.db
		.query("invites")
		.withIndex("by_email", (q) => q.eq("email", email))
		.filter((q) => q.eq(q.field("workspaceId"), workspaceId))
		.first();

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
		await dropMember(ctx, row);
	},
});

/** Leaves the workspace you have open. Your others stay; the next one opens. */
export const leave = mutation({
	args: {},
	handler: async (ctx) => {
		const member = await requireMember(ctx);
		if (member.role === "owner" && (await ownerCount(ctx, member.workspaceId)) <= 1) {
			throw new ConvexError("You're the only owner. Make someone else an owner first.");
		}
		const row = await ctx.db
			.query("members")
			.withIndex("by_user", (q) => q.eq("userId", member.userId).eq("workspaceId", member.workspaceId))
			.first();
		if (row) await dropMember(ctx, row);
	},
});

/**
 * Takes someone out of a workspace. Access ends at once (everything reads membership fresh);
 * their channel seats, automation opt-ins, and permission rules go too, so rejoining starts strict.
 * DMs keep them as a past participant.
 */
async function dropMember(ctx: MutationCtx, row: Doc<"members">) {
	const { workspaceId, userId } = row;
	await ctx.db.delete(row._id);
	for (const seat of await ctx.db
		.query("chatMembers")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.collect()) {
		if (seat.workspaceId !== workspaceId) continue;
		if ((await ctx.db.get(seat.chatId))?.kind === "channel") await ctx.db.delete(seat._id);
	}
	for (const sub of await ctx.db
		.query("automationSubscriptions")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.collect()) {
		const install = await ctx.db.get(sub.installId);
		if (install?.workspaceId === workspaceId) await ctx.db.delete(sub._id);
	}
	await forgetUserRules(ctx, workspaceId, userId);
}

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

/** One index lookup per currency field: a workspace has few types and fields. */
async function hasAmounts(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	for (const type of await typesOf(ctx, workspaceId)) {
		for (const field of await fieldsOf(ctx, type._id)) {
			if (field.kind !== "currency") continue;
			const row = await ctx.db
				.query("recordValues")
				.withIndex("by_field_str", (q) => q.eq("fieldId", field._id))
				.first();
			if (row) return true;
		}
	}
	return false;
}

/** Shared workspace settings. */
export const settings = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		const workspace = member && (await ctx.db.get(member.workspaceId));
		if (!workspace) return null;
		return {
			name: workspace.name,
			currency: workspace.currency ?? DEFAULT_CURRENCY,
			/** Whether any live record has an amount, so the app can say they keep their currency. */
			hasAmounts: await hasAmounts(ctx, workspace._id),
			version: workspace.version ?? 0,
		};
	},
});

/**
 * `currency` (ISO 4217) is the default for new amounts. Existing amounts keep their own
 * currency. Optional, so apps from before it keep working.
 */
export const updateSettings = mutation({
	args: { name: v.string(), currency: v.optional(v.string()), expectedVersion: v.number() },
	handler: async (ctx, { name, currency, expectedVersion }) => {
		const { workspaceId } = await requirePermission(ctx, "workspace.manage");
		const workspace = (await ctx.db.get(workspaceId))!;
		checkVersion(workspace.version ?? 0, expectedVersion);
		if (!name.trim()) throw new ConvexError("Name can't be empty.");
		currency = currency?.trim().toUpperCase();
		if (currency !== undefined && !isCurrencyCode(currency)) throw new ConvexError("Pick a currency code like USD.");
		await ctx.db.patch(workspaceId, { name: name.trim(), ...(currency && { currency }), version: (workspace.version ?? 0) + 1 });
	},
});
