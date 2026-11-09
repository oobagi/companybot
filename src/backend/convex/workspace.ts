import { fireEvent } from "./automationRuns";
import { DEFAULT_CURRENCY, IMAGE_BUDGET_DEFAULT_USD, IMAGE_BUDGET_MAX_USD, type ModelInfo, ROUTER_MODEL, THREAD_HOURS_DEFAULT, can, canGrantRole, defaultImageModel, isCurrencyCode, isThreadWindow, routerDecisionModels, threadWindows } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { seedAgents } from "./agents";
import { fieldsOf, typesOf } from "./recordOps";
import { activityOf, addToChat, canSee, ensureGeneral, latestMentionSince } from "./chatOps";
import { sendInviteEmail } from "./invites";
import { type Member, accessOf, checkPermission, authUserId, checkVersion, getMember, hasLiveOwner, keptWorkspace, liveWorkspace, FORMER_MEMBER, memberOf, memberProfile, nameOf, normalizeEmail, profileOf, requireMember, requirePermission, requireUserId, rolesOf } from "./lib";
import { cascading, startCascade } from "./cascade";
import { imageUrl } from "./images";
import { catalogImageModels, catalogModels, findImageModel, workspaceImageModel } from "./modelCatalog";
import { imageSpent } from "./usage";
import { removeWorkspace, startReset } from "./lifecycle";
import { savePreferences, updatePreferences } from "./preferences";
import { completeSteps, freshTutorial, welcome } from "./onboarding";
import { builtInId, checkRoles, requireGrantable, seedRoles, setMemberRoles } from "./roles";
import { writeSources } from "./replySources";
import { seedInboxSections } from "./sectionOps";

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
			/** What they may do here (core `can`), or null outside a workspace. */
			access: member ? { roles: member.roles, owner: member.owner, permissions: member.permissions } : null,
			// COMPAT(0.1.0-alpha.10): alpha.9 apps read `role` to open the app and gate their screens; delete it.
			role: member ? (member.owner ? ("owner" as const) : ("member" as const)) : null,
			workspace: workspace?.name ?? null,
			workspaceId: workspace?._id ?? null,
			/** Its logo's URL, or null for its initials. */
			workspaceImage: await imageUrl(ctx, workspace?.image),
		};
	},
});

/**
 * Runs after sign-in, and whenever you're in no workspace. Someone new joins every workspace
 * that invited them. With none, they're left in none: the app shows onboarding, which ends in
 * `setUp`. Nothing is made on their behalf, so deleting your last workspace leaves you with none.
 */
export const ensure = mutation({
	args: {},
	handler: async (ctx) => {
		if (!(await getAuthUserId(ctx))) throw new ConvexError("Not signed in.");
		// Erased accounts keep their row, scrubbed (eraseAccount); a sign-in from before can't start over in it.
		const userId = await authUserId(ctx);
		if (!userId) throw new ConvexError("This account was erased.");
		let joined = false;
		for await (const row of ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)))
			if (await keptWorkspace(ctx, row.workspaceId)) joined = true;
		if (joined) return;
		for (const invite of await invitesFor(ctx, userId)) await join(ctx, invite, userId);
	},
});

/**
 * Onboarding's last step, one transaction: your name (so the welcome greets you by it), a
 * workspace you own with its currency, and invites to your team, as members. A bad email
 * refuses the whole thing, so nothing is half set up. Returns the workspace, for the app to open.
 */
export const setUp = mutation({
	args: { displayName: v.string(), name: v.string(), currency: v.optional(v.string()), invites: v.array(v.string()) },
	handler: async (ctx, { displayName, name, currency, invites }): Promise<Id<"workspaces">> => {
		const userId = await authUserId(ctx);
		if (!userId) throw new ConvexError("Not signed in.");
		currency = currency?.trim().toUpperCase();
		if (currency !== undefined && !isCurrencyCode(currency)) throw new ConvexError("Pick a currency code like USD.");
		// Legacy setup callers may send an empty name; never clear an existing profile.
		if (displayName.trim()) await updatePreferences(ctx, userId, { displayName });
		else await savePreferences(ctx, userId, {});
		const workspaceId = await startOwned(ctx, userId, name, currency);
		const member = (await memberOf(ctx, userId, workspaceId))!;
		for (const email of invites) await inviteMember(ctx, member, { email });
		return workspaceId;
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
		return startOwned(ctx, userId, name);
	},
});

/** A workspace of your own, named, within the cap. */
async function startOwned(ctx: MutationCtx, userId: Id<"users">, name: string, currency?: string) {
	if (!name.trim()) throw new ConvexError("Name can't be empty.");
	let owned = 0;
	for await (const row of ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)))
		if ((await keptWorkspace(ctx, row.workspaceId)) && (await ownsIn(ctx, row))) owned++;
	if (owned >= MAX_OWNED_WORKSPACES) throw new ConvexError(`You can own up to ${MAX_OWNED_WORKSPACES} workspaces. Delete or leave one first.`);
	return startWorkspace(ctx, userId, name.trim(), currency);
}

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
		// Who they are in each, so a chat counts only if they can see it there (as chats.alerts).
		const members = new Map<Id<"workspaces">, Member>();
		for await (const row of ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId))) {
			const member = (await liveWorkspace(ctx, row.workspaceId)) && (await memberOf(ctx, userId, row.workspaceId));
			if (!member) continue;
			members.set(row.workspaceId, member);
			byWorkspace.set(row.workspaceId, { id: row.workspaceId, unread: false, mentions: 0 });
		}
		// Chat seats outlive leaving a workspace, so only the workspaces above count.
		for (const seat of await ctx.db
			.query("chatMembers")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.collect()) {
			const since = seat.lastReadAt ?? 0;
			const chat = await ctx.db.get(seat.chatId);
			const entry = chat && byWorkspace.get(chat.workspaceId);
			if (!chat || !entry || chat.archived || (await activityOf(ctx, chat)).lastMessageAt <= since || !(await canSee(ctx, chat, members.get(chat.workspaceId)!))) continue;
			entry.unread = true;
			if (chat.kind === "dm" || (await latestMentionSince(ctx, chat._id, userId, since))) entry.mentions++;
		}
		return [...byWorkspace.values()];
	},
});

/** A new workspace with `userId` as its owner, started as `startAgain` says. */
async function startWorkspace(ctx: MutationCtx, userId: Id<"users">, name: string, currency?: string) {
	const workspaceId = await ctx.db.insert("workspaces", { name, version: 1, ...(currency && { currency }) });
	const roles = await seedRoles(ctx, workspaceId);
	await ctx.db.insert("members", { workspaceId, userId, roles: [roles.owner], email: normalizeEmail((await ctx.db.get(userId))?.email ?? ""), ...(await memberProfile(ctx, userId)) });
	await startAgain(ctx, workspaceId, userId);
	return workspaceId;
}

/**
 * What a workspace starts with: the default agents, Inbox's sidebar sections, #general with everyone in it and a fresh
 * tutorial each, and the main agent's welcome there, from `userId` (who made it, or reset it).
 * A reset cascade ends with this too (cascade.ts), and opens the workspace again. Its roles are
 * made with it (startWorkspace) and kept by a reset. Two writes a member and no per-member reads,
 * so it fits one transaction up to ~7,000 members.
 */
export async function startAgain(ctx: MutationCtx, workspaceId: Id<"workspaces">, userId: Id<"users">) {
	await seedAgents(ctx, workspaceId, userId);
	await seedInboxSections(ctx, workspaceId);
	const general = await ensureGeneral(ctx, workspaceId, userId);
	let seats = 0;
	for await (const row of ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))) {
		await ctx.db.patch(row._id, { tutorial: freshTutorial() });
		// #general is new, so nobody's in it yet (addToChat would look, a read per member).
		await ctx.db.insert("chatMembers", { chatId: general._id, workspaceId, userId: row.userId, lastReadAt: Date.now() });
		seats++;
	}
	await ctx.db.patch(general._id, { memberCount: seats });
	await welcome(ctx, general, userId, "new_workspace");
	await ctx.db.patch(workspaceId, { resetting: undefined });
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
	// Through `accessOf`, so an Owner invite made before the migration still makes an owner.
	// COMPAT(0.1.0-alpha.10): a workspace migrations.customRoles hasn't reached yet gets its roles
	// here (the migration skips it after); delete this line with that migration.
	if ((await rolesOf(ctx, invite.workspaceId)).length === 0) await seedRoles(ctx, invite.workspaceId);
	const roles = await joiningRoles(ctx, invite);
	await ctx.db.insert("members", { workspaceId: invite.workspaceId, userId, roles, email: invite.email, tutorial: freshTutorial(), ...(await memberProfile(ctx, userId)) });
	const general = await ensureGeneral(ctx, invite.workspaceId, userId);
	await addToChat(ctx, general, { userId });
	await rememberLastUsed(ctx, userId, invite.workspaceId);
	await welcome(ctx, general, userId, "joined");
	await fireEvent(ctx, invite.workspaceId, "member.joined", {
		data: { name: await nameOf(ctx, userId), email: invite.email, roles: await roleNames(ctx, invite.workspaceId, roles) },
	});
}

/**
 * What an accepted invite gives, checked again against its inviter now (core `canGrantRole`): an invite sent
 * before that rule, or by someone who has lost a role since, can't give more than they could today. Roles
 * that don't pass become Member; an Owner's invites keep theirs. Invites from before invite emails name no
 * inviter and keep theirs (only owners invited then).
 */
async function joiningRoles(ctx: MutationCtx, invite: Doc<"invites">) {
	const all = await rolesOf(ctx, invite.workspaceId);
	const roles = accessOf(all, invite).roles;
	if (!invite.invitedBy) return roles;
	const inviter = await memberOf(ctx, invite.invitedBy, invite.workspaceId);
	const member = all.find((r) => r.builtIn === "member")!._id;
	const kept = roles.flatMap((id) => {
		const role = all.find((r) => r._id === id);
		return role && inviter && canGrantRole(inviter, { id, builtIn: role.builtIn }) ? [id] : [member];
	});
	return [...new Set(kept.length ? kept : roles)];
}

async function rememberLastUsed(ctx: MutationCtx, userId: Id<"users">, workspaceId: Id<"workspaces">) {
	const last = await lastWorkspaceOf(ctx, userId);
	if (last) await ctx.db.patch(last._id, { workspaceId });
	else await ctx.db.insert("lastWorkspaces", { userId, workspaceId });
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
			const workspace = await keptWorkspace(ctx, row.workspaceId);
			if (!workspace) continue;
			const owner = await ownsIn(ctx, row);
			// One being reset stays listed, so apps that have it open wait (resetting) instead of switching away.
			// COMPAT(0.1.0-alpha.10): alpha.9 apps read `role`; delete it.
			workspaces.push({ id: workspace._id, name: workspace.name, owner, role: owner ? ("owner" as const) : ("member" as const), image: await imageUrl(ctx, workspace.image), resetting: !!workspace.resetting });
		}
		const invitations = [];
		for (const invite of await invitesFor(ctx, userId)) {
			const workspace = await ctx.db.get(invite.workspaceId);
			if (!workspace) continue;
			const roles = await rolesOf(ctx, invite.workspaceId);
			invitations.push({
				id: invite._id,
				workspace: workspace.name,
				/** The names of the roles they'll have. */
				roles: await roleNames(ctx, invite.workspaceId, accessOf(roles, invite).roles),
				// COMPAT(0.1.0-alpha.10): alpha.9 apps read `role`; delete it.
				role: accessOf(roles, invite).owner ? ("owner" as const) : ("member" as const),
				invitedBy: invite.invitedBy ? await nameOf(ctx, invite.invitedBy) : null,
			});
		}
		return { workspaces: workspaces.sort((a, b) => a.name.localeCompare(b.name)), invitations, lastUsed: (await lastWorkspaceOf(ctx, userId))?.workspaceId ?? null };
	},
});

const lastWorkspaceOf = (ctx: QueryCtx, userId: Id<"users">) => ctx.db.query("lastWorkspaces").withIndex("by_user", (q) => q.eq("userId", userId)).first();

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
		const roles = await rolesOf(ctx, member.workspaceId);
		// Only `members` rows, which carry each person's profile: thousands of people stay one range.
		const members = await Promise.all(
			rows.map(async (r) => {
				const access = accessOf(roles, r);
				const profile = await profileOf(ctx, r);
				return {
					id: r._id,
					userId: r.userId,
					/** Their roles' ids, in the workspace's order (roles.list). */
					roles: access.roles,
					// COMPAT(0.1.0-alpha.10): alpha.9 apps read `role`; delete it.
					role: access.owner ? ("owner" as const) : ("member" as const),
					name: profile.name,
					/** Their photo's URL, or null for their initials. */
					image: await imageUrl(ctx, profile.image),
					email: r.email ?? "",
					isYou: r.userId === member.userId,
					/** Their role lets them use Inbox: who a conversation can be assigned to. */
					inbox: can(access, "inbox.use"),
					/** For profiles: the zone they picked, else their computer's. */
					timeZone: profile.timeZone,
				};
			}),
		);
		const invites =
			can(member, "members.manage")
				? (
						await ctx.db
							.query("invites")
							.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
							.collect()
					).map((i) => {
						const access = accessOf(roles, i);
						// COMPAT(0.1.0-alpha.10): alpha.9 apps read `role`; delete it.
						return { id: i._id, email: i.email, roles: access.roles, role: access.owner ? ("owner" as const) : ("member" as const) };
					})
				: [];
		return { members, invites };
	},
});

/**
 * Emails them a link to the app; they join with `roles` (Member if none) when they sign in with
 * that email. Only owners invite an owner.
 */
const inviteMemberArgs = v.object({
	email: v.string(),
	roles: v.optional(v.array(v.id("roles"))),
	// COMPAT(0.1.0-alpha.10): alpha.9 apps send "owner" or "member" instead of `roles`; delete it.
	role: v.optional(v.union(v.literal("owner"), v.literal("member"))),
});

export const invite = mutation({
	args: inviteMemberArgs.fields,
	handler: async (ctx, args) => inviteMember(ctx, await requireMember(ctx), args),
});

export async function inviteMember(ctx: MutationCtx, member: Member, args: Infer<typeof inviteMemberArgs>) {
	await writeSources(ctx, member);
	const { workspaceId, userId } = checkPermission(member, "members.manage");
	const email = normalizeEmail(args.email);
	if (!/^\S+@\S+\.\S+$/.test(email)) throw new ConvexError("That doesn't look like an email.");
	if (await isMemberEmail(ctx, workspaceId, email)) throw new ConvexError("That person is already a member.");
	if (await inviteIn(ctx, workspaceId, email)) throw new ConvexError("That person already has an invite.");
	const roles = await checkRoles(ctx, member, args.roles ?? [await builtInId(ctx, workspaceId, args.role ?? "member")]);
	const id = await ctx.db.insert("invites", { workspaceId, email, roles, invitedBy: userId });
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
	if (invite?.workspaceId !== workspaceId) return;
	const roles = await rolesOf(ctx, workspaceId);
	requireGrantable(member, roles, accessOf(roles, invite).roles, "cancel an invite with it");
	await ctx.db.delete(id);
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
	if (!owner.owner && (await ownsIn(ctx, row))) throw new ConvexError("Only owners can remove an owner.");
	// Removing someone takes every role they have: only one who could take each.
	const roles = await rolesOf(ctx, owner.workspaceId);
	requireGrantable(owner, roles, accessOf(roles, row).roles, "remove someone who has it");
	await dropMember(ctx, row);
}

/** Leaves the workspace you have open. Your others stay; the next one opens. */
export const leave = mutation({
	args: {},
	handler: async (ctx) => {
		const member = await requireMember(ctx);
		if (member.owner && !(await hasLiveOwner(ctx, member.workspaceId, member.userId))) {
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
 * Resets the open workspace (owners): `name` must match, as for deleting. Everything in it goes,
 * as when deleting it (lifecycle.ts, scope "reset"), except its members, invites, settings and
 * bill; then it starts again like new (startAgain). Closed meanwhile for everyone (memberOf
 * refuses it), so nothing new lands in a half-reset workspace. Who reset it, and when, stays on it.
 */
export const resetWorkspace = mutation({
	args: { name: v.string() },
	handler: async (ctx, { name }) => {
		const { workspaceId, userId } = await requirePermission(ctx, "workspace.reset");
		if ((await ctx.db.get(workspaceId))!.name !== name.trim()) throw new ConvexError("Type the workspace's name to reset it.");
		await startReset(ctx, workspaceId, userId);
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
			if (!(await keptWorkspace(ctx, row.workspaceId)) || !(await ownsIn(ctx, row)) || (await hasLiveOwner(ctx, row.workspaceId, userId))) continue;
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
		// Their memberships wait for the cascade: until then they keep nothing that names them, and show as a former member.
		for await (const row of ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)))
			await ctx.db.patch(row._id, { email: "", name: FORMER_MEMBER, image: undefined });
		await startCascade(ctx, "user", { userId });
	},
});

/** Gives someone exactly these roles (roles.ts `setMemberRoles`). Takes effect at once, including for replies already running. */
export const setRoles = mutation({
	args: { id: v.id("members"), roles: v.array(v.id("roles")) },
	handler: async (ctx, { id, roles }) => {
		const member = await requirePermission(ctx, "members.manage");
		const row = await ctx.db.get(id);
		if (!row || row.workspaceId !== member.workspaceId) throw new ConvexError("Member not found.");
		await setMemberRoles(ctx, member, row, roles);
	},
});

// COMPAT(0.1.0-alpha.10): alpha.9 apps pick Owner or Member here. Gives or takes the Owner role and keeps
// the rest (Member if nothing's left); delete it.
export const setRole = mutation({
	args: { id: v.id("members"), role: v.union(v.literal("owner"), v.literal("member")) },
	handler: async (ctx, { id, role }) => {
		const member = await requirePermission(ctx, "members.manage");
		const row = await ctx.db.get(id);
		if (!row || row.workspaceId !== member.workspaceId) throw new ConvexError("Member not found.");
		const owner = await builtInId(ctx, member.workspaceId, "owner");
		const rest = accessOf(await rolesOf(ctx, member.workspaceId), row).roles.filter((r) => r !== owner);
		const roles = role === "owner" ? [owner, ...rest] : rest.length > 0 ? rest : [await builtInId(ctx, member.workspaceId, "member")];
		await setMemberRoles(ctx, member, row, roles);
	},
});

/** Whether this membership holds the Owner role. */
export async function ownsIn(ctx: QueryCtx, row: Doc<"members">) {
	return accessOf(await rolesOf(ctx, row.workspaceId), row).owner;
}

/** The names of these roles, in the workspace's order. */
async function roleNames(ctx: QueryCtx, workspaceId: Id<"workspaces">, ids: Id<"roles">[]) {
	return (await rolesOf(ctx, workspaceId)).filter((r) => ids.includes(r._id)).map((r) => r.name);
}

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

/**
 * The picture settings: the model, the monthly budget in USD (0 = off), what the picker offers,
 * and this month's spend for people who see the workspace's usage (`usage.view`), else null.
 */
export async function imageSettings(ctx: QueryCtx, member: Member, workspace: Doc<"workspaces">) {
	return {
		imageModel: (await workspaceImageModel(ctx, workspace.imageModel)).id,
		imageBudgetUsd: workspace.imageBudgetUsd ?? IMAGE_BUDGET_DEFAULT_USD,
		imageModels: await catalogImageModels(ctx),
		imageSpentUsd: can(member, "usage.view") ? await imageSpent(ctx, workspace._id) : null,
	};
}

/** What can decide replies: decision models (Jev) first, then every AI Gateway language model. */
async function routerModels(ctx: QueryCtx): Promise<ModelInfo[]> {
	return [...routerDecisionModels, ...(await catalogModels(ctx)).models];
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
			...(await imageSettings(ctx, member, workspace)),
		/** What decides whether agents reply in "When relevant" channels, and what it can be. */
		routerModel: workspace.routerModel ?? ROUTER_MODEL,
		routerModels: await routerModels(ctx),
			/** Hours a thread stays under its channel in the sidebar after its last reply. */
			threadHours: workspace.threadHours ?? THREAD_HOURS_DEFAULT,
			/** Who last reset it, and when, or null. */
			lastReset: workspace.lastReset ? { by: await nameOf(ctx, workspace.lastReset.by), at: workspace.lastReset.at } : null,
			version: workspace.version ?? 0,
		};
	},
});

/**
 * `currency` (ISO 4217) is the default for new amounts. Existing amounts keep their own
 * currency. `memory` turns agent memory on or off; off keeps every memory. `imageModel` is what
 * agents make pictures with; `imageBudgetUsd` what they may spend on them a month (0 = off). All
 * optional, so apps from before them keep working.
 */
const updateWorkspaceSettingsArgs = v.object({
	name: v.string(),
	currency: v.optional(v.string()),
	memory: v.optional(v.boolean()),
	imageModel: v.optional(v.string()),
	imageBudgetUsd: v.optional(v.number()),
	routerModel: v.optional(v.string()),
	threadHours: v.optional(v.number()),
	expectedVersion: v.number(),
});

export const updateSettings = mutation({
	args: updateWorkspaceSettingsArgs.fields,
	handler: async (ctx, args) => updateWorkspaceSettings(ctx, await requireMember(ctx), args),
});

export async function updateWorkspaceSettings(ctx: MutationCtx, member: Member, { name, currency, memory, imageModel, imageBudgetUsd, routerModel, threadHours, expectedVersion }: Infer<typeof updateWorkspaceSettingsArgs>) {
	const { workspaceId } = checkPermission(member, "workspace.manage");
	const workspace = (await ctx.db.get(workspaceId))!;
	checkVersion(workspace.version ?? 0, expectedVersion);
	if (name.trim() !== workspace.name) await writeSources(ctx, member);
	if (!name.trim()) throw new ConvexError("Name can't be empty.");
	currency = currency?.trim().toUpperCase();
	if (currency !== undefined && !isCurrencyCode(currency)) throw new ConvexError("Pick a currency code like USD.");
	// The current pick stays allowed, so a model that left the gateway doesn't block other edits.
	if (imageModel !== undefined && imageModel !== (workspace.imageModel ?? defaultImageModel) && !(await findImageModel(ctx, imageModel))) {
		throw new ConvexError("Pick one of the picture models offered.");
	}
	if (routerModel !== undefined && routerModel !== (workspace.routerModel ?? ROUTER_MODEL) && !(await routerModels(ctx)).some((m) => m.id === routerModel)) {
		throw new ConvexError("Pick one of the reply decision models offered.");
	}
	if (imageBudgetUsd !== undefined && !(imageBudgetUsd >= 0 && imageBudgetUsd <= IMAGE_BUDGET_MAX_USD)) {
		throw new ConvexError(`Set an image budget from $0 (off) to $${IMAGE_BUDGET_MAX_USD.toLocaleString("en-US")} a month.`);
	}
	if (threadHours !== undefined && !isThreadWindow(threadHours)) throw new ConvexError(`Threads stay in the sidebar for ${threadWindows.map((w) => w.hours).join(", ")} hours (0 is forever).`);
	await ctx.db.patch(workspaceId, {
		name: name.trim(),
		...(currency && { currency }),
		...(memory !== undefined && { memory }),
		...(imageModel !== undefined && { imageModel }),
		...(routerModel !== undefined && { routerModel }),
		...(imageBudgetUsd !== undefined && { imageBudgetUsd: Math.round(imageBudgetUsd * 100) / 100 }),
		...(threadHours !== undefined && { threadHours }),
		version: (workspace.version ?? 0) + 1,
	});
}