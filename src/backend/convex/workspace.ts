import { fireEvent } from "./automationRuns";
import { DEFAULT_CURRENCY, can, isCurrencyCode } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { seedAgents } from "./agents";
import { fieldsOf, typesOf } from "./recordOps";
import { addToChat, ensureGeneral, latestMentionSince } from "./chatOps";
import { sendInviteEmail } from "./invites";
import { type Member, checkPermission, authUserId, checkVersion, getMember, hasLiveOwner, liveWorkspace, memberOf, nameOf, normalizeEmail, personOf, preferencesOf, requireMember, requirePermission, requireUserId, timeZoneOf } from "./lib";
import { cascading, startCascade } from "./cascade";
import { imageUrl } from "./images";
import { removeWorkspace } from "./lifecycle";
import { completeSteps, freshTutorial, welcome } from "./onboarding";
import { role } from "./schema";

export const me = query({
	args: {},
	handler: async (ctx) => {
		const userId = await authUserId(ctx);
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
			/** Its logo's URL, or null for its initials. */
			workspaceImage: await imageUrl(ctx, workspace?.image),
		};
	},
});

/** Runs after sign-in. Someone new joins every workspace that invited them, or starts one as owner. */
export const ensure = mutation({
	args: {},
	handler: async (ctx) => {
		if (!(await getAuthUserId(ctx))) throw new ConvexError("Not signed in.");
		// Erased accounts keep their row, scrubbed (eraseAccount); a sign-in from before can't start over in it.
		const userId = await authUserId(ctx);
		if (!userId) throw new ConvexError("This account was erased.");
		let joined = false;
		for await (const row of ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)))
			if (await liveWorkspace(ctx, row.workspaceId)) joined = true;
		if (joined) return;

		const invites = await invitesFor(ctx, userId);
		for (const invite of invites) await join(ctx, invite, userId);
		if (invites.length > 0) return;

		await startWorkspace(ctx, userId, "My company");
	},
});

/** How many live workspaces one person may own. */
export const MAX_OWNED_WORKSPACES = 10;

/** Starts another workspace, with you as its owner (the rail's "+"). Returns it, for the app to open. */
export const create = mutation({
	args: { name: v.string() },
	handler: async (ctx, { name }): Promise<Id<"workspaces">> => {
		const userId = await authUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		if (!name.trim()) throw new ConvexError("Name can't be empty.");
		let owned = 0;
		for await (const row of ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)))
			if (row.role === "owner" && (await liveWorkspace(ctx, row.workspaceId))) owned++;
		if (owned >= MAX_OWNED_WORKSPACES) throw new ConvexError(`You can own up to ${MAX_OWNED_WORKSPACES} workspaces. Delete or leave one first.`);
		return startWorkspace(ctx, userId, name.trim());
	},
});

/**
 * For the rail, account-wide like `mine`: per workspace you're in, whether a chat has something
 * unread, and how many chats have an unread @mention of you or an unread DM (the count on its icon).
 */
export const activity = query({
	args: {},
	handler: async (ctx): Promise<{ id: Id<"workspaces">; unread: boolean; mentions: number }[]> => {
		const userId = await authUserId(ctx);
		if (!userId) return [];
		const byWorkspace = new Map<Id<"workspaces">, { id: Id<"workspaces">; unread: boolean; mentions: number }>();
		for await (const row of ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)))
			if (await liveWorkspace(ctx, row.workspaceId)) byWorkspace.set(row.workspaceId, { id: row.workspaceId, unread: false, mentions: 0 });
		// Chat seats outlive leaving a workspace, so only the workspaces above count.
		for (const seat of await ctx.db
			.query("chatMembers")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect()) {
			const since = seat.lastReadAt ?? 0;
			const chat = await ctx.db.get(seat.chatId);
			const entry = chat && byWorkspace.get(chat.workspaceId);
			if (!chat || !entry || chat.archived || chat.lastMessageAt <= since) continue;
			entry.unread = true;
			if (chat.kind === "dm" || (await latestMentionSince(ctx, chat._id, userId, since))) entry.mentions++;
		}
		return [...byWorkspace.values()];
	},
});

/** A new workspace with `userId` as its owner: the default agents, #general, and a welcome there. */
async function startWorkspace(ctx: MutationCtx, userId: Id<"users">, name: string) {
	const workspaceId = await ctx.db.insert("workspaces", { name, version: 1 });
	await ctx.db.insert("members", { workspaceId, userId, role: "owner", email: normalizeEmail((await ctx.db.get(userId))?.email ?? ""), tutorial: freshTutorial() });
	await seedAgents(ctx, workspaceId, userId);
	const general = await ensureGeneral(ctx, workspaceId, userId);
	await addToChat(ctx, general, { userId });
	await welcome(ctx, general, userId, "new_workspace");
	return workspaceId;
}

/**
 * Pending invites to this person's (verified) email, from workspaces that aren't being deleted
 * and still have an owner: a sole owner's erased account leaves theirs to be deleted (lifecycle.ts).
 */
async function invitesFor(ctx: QueryCtx, userId: Id<"users">) {
	const email = normalizeEmail((await ctx.db.get(userId))?.email ?? "");
	if (!email) return [];
	const invites = [];
	for await (const invite of ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", email)))
		if ((await liveWorkspace(ctx, invite.workspaceId)) && (await hasLiveOwner(ctx, invite.workspaceId))) invites.push(invite);
	return invites;
}

/** Uses up an invite: they're in, in #general, and it's their last-used workspace. */
async function join(ctx: MutationCtx, invite: Doc<"invites">, userId: Id<"users">) {
	// What they had here before is still being deleted: joining now could bring it back. If it's
	// stuck, the fix is to resume it (wiki/data.md), never to delete it.
	if (await cascading(ctx, "member", { workspaceId: invite.workspaceId, userId }))
		throw new ConvexError("What you had in this workspace before is still being cleaned up. Try again in a few minutes.");
	await ctx.db.delete(invite._id);
	if (await memberOf(ctx, userId, invite.workspaceId)) return;
	await ctx.db.insert("members", { workspaceId: invite.workspaceId, userId, role: invite.role, email: invite.email, tutorial: freshTutorial() });
	const general = await ensureGeneral(ctx, invite.workspaceId, userId);
	await addToChat(ctx, general, { userId });
	await rememberLastUsed(ctx, userId, invite.workspaceId);
	await welcome(ctx, general, userId, "joined");
	await fireEvent(ctx, invite.workspaceId, "member.joined", {
		data: { name: await nameOf(ctx, userId), email: invite.email, role: invite.role },
	});
}

async function rememberLastUsed(ctx: MutationCtx, userId: Id<"users">, workspaceId: Id<"workspaces">) {
	const prefs = await preferencesOf(ctx, userId);
	if (prefs) await ctx.db.patch(prefs._id, { workspaceId });
	else await ctx.db.insert("preferences", { userId, displayName: "", sendWith: "enter", workspaceId });
}

/**
 * The workspaces you're in, invites waiting for you, and the one you used last (a hint for
 * a device opening for the first time). Which one is open is each device's own choice.
 */
export const mine = query({
	args: {},
	handler: async (ctx) => {
		const userId = await authUserId(ctx);
		if (!userId) return null;
		const rows = await ctx.db
			.query("members")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect();
		const workspaces = [];
		for (const row of rows) {
			const workspace = await liveWorkspace(ctx, row.workspaceId);
			if (workspace) workspaces.push({ id: workspace._id, name: workspace.name, role: row.role, image: await imageUrl(ctx, workspace.image) });
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
		const prefs = await preferencesOf(ctx, userId);
		return { workspaces: workspaces.sort((a, b) => a.name.localeCompare(b.name)), invitations, lastUsed: prefs?.workspaceId ?? null };
	},
});

/** Notes the workspace a device switched to as your last used. Other devices keep theirs. */
export const switchTo = mutation({
	args: { to: v.id("workspaces") },
	handler: async (ctx, { to: workspaceId }) => {
		const userId = await authUserId(ctx);
		if (!userId || !(await memberOf(ctx, userId, workspaceId))) throw new ConvexError("You're not in that workspace.");
		await rememberLastUsed(ctx, userId, workspaceId);
	},
});

/** An invite to your own email, so nobody can use one meant for someone else. */
async function requireMyInvite(ctx: QueryCtx, id: Id<"invites">) {
	const userId = await authUserId(ctx);
	const invite = userId && (await invitesFor(ctx, userId)).find((i) => i._id === id);
	if (!userId || !invite) throw new ConvexError("That invite isn't available anymore.");
	return { userId, invite };
}

/** Returns the workspace, so the app can open it. */
export const acceptInvite = mutation({
	args: { id: v.id("invites") },
	handler: async (ctx, { id }): Promise<Id<"workspaces">> => {
		const { userId, invite } = await requireMyInvite(ctx, id);
		await join(ctx, invite, userId);
		return invite.workspaceId;
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
		const members = await Promise.all(
			rows.map(async (r) => {
				const person = await personOf(ctx, r.userId);
				return {
					id: r._id,
					userId: r.userId,
					role: r.role,
					name: person.name,
					/** Their photo's URL, or null for their initials. */
					image: await imageUrl(ctx, person.image),
					email: (await ctx.db.get(r.userId))?.email ?? "",
					isYou: r.userId === member.userId,
					/** For profiles: the zone they picked, else their computer's. */
					timeZone: await timeZoneOf(ctx, r.userId),
				};
			}),
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
const inviteMemberArgs = v.object({ email: v.string(), role });

export const invite = mutation({
	args: inviteMemberArgs.fields,
	handler: async (ctx, args) => inviteMember(ctx, await requireMember(ctx), args),
});

export async function inviteMember(ctx: MutationCtx, member: Member, args: Infer<typeof inviteMemberArgs>) {
	const { workspaceId, userId } = checkPermission(member, "members.manage");
	const email = normalizeEmail(args.email);
	if (!/^\S+@\S+\.\S+$/.test(email)) throw new ConvexError("That doesn't look like an email.");
	if (await isMemberEmail(ctx, workspaceId, email)) throw new ConvexError("That person is already a member.");
	if (await inviteIn(ctx, workspaceId, email)) throw new ConvexError("That person already has an invite.");
	const id = await ctx.db.insert("invites", { workspaceId, email, role: args.role, invitedBy: userId });
	await completeSteps(ctx, member, ["invite"]);
	/** False when they got one a moment ago (say, an invite cancelled and made again). */
	const emailed = await sendInviteEmail(ctx, (await ctx.db.get(id))!, userId);
	return { emailed };
}

/** Sends the invite email again. Limited, so nobody's inbox gets flooded. */
const resendMemberInviteArgs = v.object({ id: v.id("invites") });

export const resendInvite = mutation({
	args: resendMemberInviteArgs.fields,
	handler: async (ctx, args) => resendMemberInvite(ctx, await requireMember(ctx), args),
});

export async function resendMemberInvite(ctx: MutationCtx, member: Member, { id }: Infer<typeof resendMemberInviteArgs>) {
	const { workspaceId, userId } = checkPermission(member, "members.manage");
	const invite = await ctx.db.get(id);
	if (invite?.workspaceId !== workspaceId) throw new ConvexError("That invite isn't available anymore.");
	await sendInviteEmail(ctx, invite, userId, { resend: true });
}

export const inviteIn = (ctx: QueryCtx, workspaceId: Id<"workspaces">, email: string) =>
	ctx.db.query("invites").withIndex("by_workspace_email", q => q.eq("workspaceId", workspaceId).eq("email", email)).first();

const cancelMemberInviteArgs = v.object({ id: v.id("invites") });

export const cancelInvite = mutation({
	args: cancelMemberInviteArgs.fields,
	handler: async (ctx, args) => cancelMemberInvite(ctx, await requireMember(ctx), args),
});

export async function cancelMemberInvite(ctx: MutationCtx, member: Member, { id }: Infer<typeof cancelMemberInviteArgs>) {
	const { workspaceId } = checkPermission(member, "members.manage");
	const invite = await ctx.db.get(id);
	if (invite?.workspaceId === workspaceId) await ctx.db.delete(id);
}

const removeWorkspaceMemberArgs = v.object({ id: v.id("members") });

export const removeMember = mutation({
	args: removeWorkspaceMemberArgs.fields,
	handler: async (ctx, args) => removeWorkspaceMember(ctx, await requireMember(ctx), args),
});

export async function removeWorkspaceMember(ctx: MutationCtx, member: Member, { id }: Infer<typeof removeWorkspaceMemberArgs>) {
	const owner = checkPermission(member, "members.manage");
	const row = await ctx.db.get(id);
	if (!row || row.workspaceId !== owner.workspaceId) return;
	if (row.userId === owner.userId) throw new ConvexError("You can't remove yourself.");
	await dropMember(ctx, row);
}

/** Leaves the workspace you have open. Your others stay; the next one opens. */
export const leave = mutation({
	args: {},
	handler: async (ctx) => {
		const member = await requireMember(ctx);
		if (member.role === "owner" && !(await hasLiveOwner(ctx, member.workspaceId, member.userId))) {
			throw new ConvexError("You're the only owner. Make someone else an owner first.");
		}
		const row = await ctx.db.get(member.id);
		if (row) await dropMember(ctx, row);
	},
});

/**
 * Takes someone out of a workspace. Access ends at once: their membership goes now, and
 * everything reads it fresh. What was theirs alone goes in a member cascade (lifecycle.ts):
 * channel seats, automation opt-ins, permission rules, personal connector accounts and
 * memories, automations only they could see, unread mentions. Rejoining waits until it's
 * done, so it starts strict. DMs keep them as a past participant.
 */
async function dropMember(ctx: MutationCtx, row: Doc<"members">) {
	const { workspaceId, userId } = row;
	await ctx.db.delete(row._id);
	await startCascade(ctx, "member", { workspaceId, userId });
}

/**
 * Deletes the open workspace and everything in it (owners). `name` must match, so it's never
 * an accident. Access ends at once for everyone (memberOf refuses a workspace being deleted),
 * in a transaction that stays small however many members it has; a workspace cascade
 * (lifecycle.ts) then deletes its rows, and it last.
 */
export const deleteWorkspace = mutation({
	args: { name: v.string() },
	handler: async (ctx, { name }) => {
		const { workspaceId } = await requirePermission(ctx, "workspace.delete");
		if ((await ctx.db.get(workspaceId))!.name !== name.trim()) throw new ConvexError("Type the workspace's name to delete it.");
		await removeWorkspace(ctx, workspaceId);
	},
});

/**
 * Erases your account. You leave every workspace (one you're alone in is deleted), and your
 * sign-in, preferences, connected accounts, private agent results and everything personal go
 * (lifecycle.ts, scope "user"). The `users` row stays as `{ erasedAt }`, since ~20 tables point
 * at it: what you said and did stays in workspace history, as a former member's.
 * Refused while you're the only owner of a workspace with other people in it.
 */
export const eraseAccount = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		// A few indexed reads per workspace however big it is. Leaving them is the cascade's (memberOf refuses an erased account until then).
		for await (const row of ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId))) {
			// One being deleted is going anyway, however many memberships its cascade has left to delete.
			if (row.role !== "owner" || !(await liveWorkspace(ctx, row.workspaceId)) || (await hasLiveOwner(ctx, row.workspaceId, userId))) continue;
			const others = await ctx.db
				.query("members")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", row.workspaceId))
				.take(2);
			if (others.length > 1) {
				const workspace = await ctx.db.get(row.workspaceId);
				throw new ConvexError(`You're the only owner of ${workspace?.name ?? "a workspace"}. Make someone else an owner first, or remove everyone else.`);
			}
		}
		// Now, not in the cascade: their email must sign in to a new account, never back into this one.
		const emails = new Set([(await ctx.db.get(userId))!.email]);
		for await (const account of ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId))) {
			for await (const code of ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", account._id))) await ctx.db.delete(code._id);
			emails.add(account.providerAccountId);
			await ctx.db.delete(account._id);
		}
		// Rows keyed by their email, found while it's still known.
		for (const email of emails) {
			if (!email) continue;
			for (const row of await ctx.db.query("authRateLimits").withIndex("identifier", (q) => q.eq("identifier", email)).collect()) await ctx.db.delete(row._id);
			for (const row of await ctx.db.query("localSignInCodes").withIndex("by_email", (q) => q.eq("email", email)).collect()) await ctx.db.delete(row._id);
		}
		await ctx.db.replace(userId, { erasedAt: Date.now() });
		await startCascade(ctx, "user", { userId });
	},
});

/** Takes effect at once, including for replies already running. */
export const setRole = mutation({
	args: { id: v.id("members"), role },
	handler: async (ctx, { id, role }) => {
		const owner = await requirePermission(ctx, "members.manage");
		const row = await ctx.db.get(id);
		if (!row || row.workspaceId !== owner.workspaceId) throw new ConvexError("Member not found.");
		if (row.role === "owner" && role !== "owner" && !(await hasLiveOwner(ctx, owner.workspaceId, row.userId))) {
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

/** Whether someone with this (normalized) email is already in the workspace. */
async function isMemberEmail(ctx: QueryCtx, workspaceId: Id<"workspaces">, email: string) {
	// Fail closed until old memberships have been indexed; never fall back to a team scan.
	const missing = await ctx.db.query("members").withIndex("by_email", q => q.eq("workspaceId", workspaceId).eq("email", undefined)).first();
	if (missing) throw new ConvexError("Member lookup is being updated. Try again shortly.");
	const rows = await ctx.db.query("members").withIndex("by_email", q => q.eq("workspaceId", workspaceId).eq("email", email)).take(2);
	for (const row of rows) if (await memberOf(ctx, row.userId, workspaceId)) return true;
	if (rows.length === 2) throw new ConvexError("Previous memberships are still being cleaned up. Try again shortly.");
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
			/** Whether agents read and write memories. */
			memory: workspace.memory ?? true,
			/** Its logo's URL, or null for its initials. */
			image: await imageUrl(ctx, workspace.image),
			/** Whether any live record has an amount, so the app can say they keep their currency. */
			hasAmounts: await hasAmounts(ctx, workspace._id),
			version: workspace.version ?? 0,
		};
	},
});

/**
 * `currency` (ISO 4217) is the default for new amounts. Existing amounts keep their own
 * currency. `memory` turns agent memory on or off; off keeps every memory. Both optional,
 * so apps from before them keep working.
 */
const updateWorkspaceSettingsArgs = v.object({ name: v.string(), currency: v.optional(v.string()), memory: v.optional(v.boolean()), expectedVersion: v.number() });

export const updateSettings = mutation({
	args: updateWorkspaceSettingsArgs.fields,
	handler: async (ctx, args) => updateWorkspaceSettings(ctx, await requireMember(ctx), args),
});

export async function updateWorkspaceSettings(ctx: MutationCtx, member: Member, { name, currency, memory, expectedVersion }: Infer<typeof updateWorkspaceSettingsArgs>) {
	const { workspaceId } = checkPermission(member, "workspace.manage");
	const workspace = (await ctx.db.get(workspaceId))!;
	checkVersion(workspace.version ?? 0, expectedVersion);
	if (!name.trim()) throw new ConvexError("Name can't be empty.");
	currency = currency?.trim().toUpperCase();
	if (currency !== undefined && !isCurrencyCode(currency)) throw new ConvexError("Pick a currency code like USD.");
	await ctx.db.patch(workspaceId, {
		name: name.trim(),
		...(currency && { currency }),
		...(memory !== undefined && { memory }),
		version: (workspace.version ?? 0) + 1,
	});
}