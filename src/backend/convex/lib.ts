import {
	type Actor,
	type BuiltInRole,
	type Permission,
	type RoleInfo,
	roleSwitches,
	type Skill,
	can,
	customSkill,
	deniedMessage,
	resolveTimeZone,
} from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { FunctionReference, PaginationResult } from "convex/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { readArtifact } from "./replySources";
import type { Requested } from "./functions";

export interface Member extends Actor {
	/** Set only by the turn runner: shared readers record sources on this reply. */
	replyId?: Id<"chatMessages">;
	/** The `members` row. */
	id: Id<"members">;
	userId: Id<"users">;
	workspaceId: Id<"workspaces">;
	roles: Id<"roles">[];
	/** Every role in the workspace, so a refusal can name the ones that would do (core `deniedMessage`). */
	workspaceRoles: (RoleInfo & { id: Id<"roles">; builtIn: BuiltInRole | null })[];
}

export const toActor = (m: Member): Actor => ({ userId: m.userId, roles: m.roles, owner: m.owner, permissions: m.permissions });

/** A workspace's roles: Owner, Member, then the ones owners made, oldest first. A handful per workspace. */
export async function rolesOf(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const rows = await ctx.db
		.query("roles")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	const rank = (r: Doc<"roles">) => (r.builtIn === "owner" ? 0 : r.builtIn === "member" ? 1 : 2);
	return rows.sort((a, b) => rank(a) - rank(b) || a._creationTime - b._creationTime);
}

export const roleInfo = (r: Doc<"roles">) => ({ id: r._id, name: r.name, owner: r.builtIn === "owner", builtIn: r.builtIn ?? null, permissions: roleSwitches(r.builtIn, r.switches) });

/** One of the two roles every workspace has. */
export async function builtInRole(ctx: QueryCtx, workspaceId: Id<"workspaces">, which: BuiltInRole) {
	const role = (await rolesOf(ctx, workspaceId)).find((r) => r.builtIn === which);
	if (!role) throw new ConvexError("This workspace's roles are being set up. Try again shortly.");
	return role;
}

/** What holding `held` lets someone do: everything with Owner, else every switch any of them has. Ids of deleted roles count for nothing. */
export function accessFrom(roles: Doc<"roles">[], held: Id<"roles">[]) {
	const mine = roles.filter((r) => held.includes(r._id));
	return {
		roles: mine.map((r) => r._id),
		owner: mine.some((r) => r.builtIn === "owner"),
		permissions: [...new Set(mine.flatMap((r) => roleSwitches(r.builtIn, r.switches)))],
	};
}

/**
 * What a membership or invite lets its person do, and the role ids it holds. Every access and
 * ownership check reads rows through this: membership, last owner, leaving, erasing, invites.
 */
export function accessOf(roles: Doc<"roles">[], row: { roles?: Id<"roles">[]; role?: BuiltInRole }) {
	if (row.roles) return accessFrom(roles, row.roles);
	// COMPAT(0.1.0-alpha.10): rows from before custom roles keep the old `role` until
	// migrations.customRolesMembers/Invites backfill `roles`, and a workspace has no roles until
	// migrations.customRoles seeds them. Read the old value as the built-in role it becomes, so
	// nobody gains, loses or orphans anything mid-migration. Once those have run on prod, delete
	// from here down and read `row.roles` (required by then).
	if (!row.role) return accessFrom(roles, []);
	const role = roles.find((r) => r.builtIn === row.role);
	if (role) return accessFrom(roles, [role._id]);
	// Not seeded yet: a stand-in id lets connector access ("member" on old installs) match it too.
	return { roles: row.role === "member" ? [UNSEEDED_MEMBER] : [], owner: row.role === "owner", permissions: roleSwitches(row.role, []) };
}

/** COMPAT(0.1.0-alpha.10): the Member role of a workspace whose roles aren't seeded yet. Never stored. Delete with `accessOf`'s fallback. */
export const UNSEEDED_MEMBER = "unseeded:member" as Id<"roles">;

/**
 * Who's acting: a member, or an agent acting for one (its `agentId` set). Every change an
 * agent makes goes through the same functions as the app, with this.
 */
export interface Who {
	member: Member;
	agentId?: Id<"agents">;
}

/**
 * Their membership in one workspace, read fresh, so role changes and removals apply right
 * away (even mid-reply). People can be in several workspaces, so always say which.
 */
export async function memberOf(ctx: QueryCtx, userId: Id<"users">, workspaceId: Id<"workspaces">): Promise<Member | null> {
	const row = await ctx.db
		.query("members")
		.withIndex("by_user", (q) => q.eq("userId", userId).eq("workspaceId", workspaceId))
		.first();
	// An erased account's memberships go in its cascade; until then it acts nowhere.
	if (!row || (await erased(ctx, userId)) || !(await liveWorkspace(ctx, workspaceId))) return null;
	const roles = await rolesOf(ctx, workspaceId);
	return { id: row._id, userId, workspaceId, ...accessOf(roles, row), workspaceRoles: roles.map(roleInfo) };
}

/** Whether their account was erased (workspace.eraseAccount). */
export const erased = async (ctx: QueryCtx, userId: Id<"users">) => !!(await ctx.db.get(userId))?.erasedAt;

/**
 * Whether someone besides `except` owns it. An erased owner doesn't count: their membership is on its way out.
 * Roles are a list on each membership, which Convex can't index, so this reads members until it finds an
 * owner: the first is nearly always the one who made the workspace.
 */
export async function hasLiveOwner(ctx: QueryCtx, workspaceId: Id<"workspaces">, except?: Id<"users">) {
	const roles = await rolesOf(ctx, workspaceId);
	for await (const row of ctx.db.query("members").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)))
		if (accessOf(roles, row).owner && row.userId !== except && !(await erased(ctx, row.userId))) return true;
	return false;
}

/** A workspace that exists and isn't being deleted. Deleting one ends every access to it at once. */
export async function liveWorkspace(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const workspace = await ctx.db.get(workspaceId);
	return workspace && !workspace.deleting ? workspace : null;
}

/**
 * The signed-in person, unless their account was erased: a sign-in token from before stays
 * valid until it expires, so everything keyed on the token's user goes through this.
 */
export async function authUserId(ctx: QueryCtx) {
	const userId = await getAuthUserId(ctx);
	const user = userId && (await ctx.db.get(userId));
	return user && !user.erasedAt ? user._id : null;
}

/** The signed-in person (as `authUserId`), or "Not signed in." */
export async function requireUserId(ctx: QueryCtx) {
	const userId = await authUserId(ctx);
	if (!userId) throw new ConvexError("Not signed in.");
	return userId;
}

/**
 * The signed-in person in the workspace this request is for (`functions.ts` puts it on ctx).
 * Null if they're not in it: a request can only act where its sender is a member.
 */
export async function getMember(ctx: QueryCtx): Promise<Member | null> {
	const userId = await authUserId(ctx);
	if (!userId) return null;
	return memberFor(ctx, userId, (ctx as QueryCtx & Partial<Requested>).workspaceId);
}

/** Their membership in the requested workspace; none named, none. */
export const memberFor = async (ctx: QueryCtx, userId: Id<"users">, workspaceId: Id<"workspaces"> | undefined) =>
	workspaceId ? memberOf(ctx, userId, workspaceId) : null;

export async function requireMember(ctx: QueryCtx): Promise<Member> {
	const member = await getMember(ctx);
	if (!member) throw new ConvexError("Sign in to a workspace first.");
	return member;
}

/** The signed-in member, if their role has `permission` (see core/permissions.ts). */
export async function requirePermission(ctx: QueryCtx, permission: Permission): Promise<Member> {
	return checkPermission(await requireMember(ctx), permission);
}

/** `load`, called at most once per key: for a read many rows in one call share. */
export function memo<K, V>(load: (key: K) => Promise<V>) {
	const cache = new Map<K, Promise<V>>();
	return (key: K) => {
		let value = cache.get(key);
		if (!value) cache.set(key, (value = load(key)));
		return value;
	};
}

/** Role check shared by app mutations and operations acting for a turn. A refusal names the roles that have it. */
export function checkPermission(member: Member, permission: Permission): Member {
	if (!can(member, permission)) throw new ConvexError(deniedMessage(permission, member.workspaceRoles));
	return member;
}

/**
 * A row from the workspace this request is for, or "<what> not found." Every public function
 * that takes an id checks the row with this (or a require* helper built on it): an id from
 * another workspace, even one the person is also in, looks like it doesn't exist.
 */
export function requireInWorkspace<T extends { workspaceId: Id<"workspaces"> }>(member: Member, row: T | null, what: string): T {
	if (!row || row.workspaceId !== member.workspaceId) throw new ConvexError(`${what} not found.`);
	return row;
}

/** An agent in the person's workspace. Other workspaces' agents look like they don't exist. */
export async function requireAgent(ctx: QueryCtx, member: Member, agentId: Id<"agents">) {
	return requireInWorkspace(member, await ctx.db.get(agentId), "Agent");
}

/** An agent that isn't in Archive: one there is read-only until it's restored. */
export async function requireLiveAgent(ctx: QueryCtx, member: Member, agentId: Id<"agents">) {
	const agent = await requireAgent(ctx, member, agentId);
	if (agent.archived) throw new ConvexError("This agent is in Archive. Restore it first.");
	return agent;
}

/** Refuses a save that started from an older version than what's stored now. */
export function checkVersion(current: number, expected: number) {
	if (current !== expected) {
		throw new ConvexError({ code: "conflict", message: "Someone else saved a change while you were editing." });
	}
}

/** Metadata shared by skills and automations people make. */
export function madeCustom<Config>(config: Config, userId: Id<"users">) {
	return { ...config, version: 1, updatedBy: userId, updatedAt: Date.now() };
}

/** Check the version before validation, then save once. */
export async function saveMade<Config, Custom extends { version: number }>({
	current,
	expectedVersion,
	config,
	userId,
	validate,
	patch,
}: {
	current: Custom;
	expectedVersion: number;
	config: Config;
	userId: Id<"users">;
	validate: () => void | Promise<void>;
	patch: (custom: Custom & Config & ReturnType<typeof madeCustom<Config>>) => Promise<void>;
}) {
	checkVersion(current.version, expectedVersion);
	await validate();
	await patch({ ...current, ...madeCustom(config, userId), version: current.version + 1 });
}

/** A page with nothing on it. */
export const emptyPage = (): PaginationResult<never> => ({ page: [], isDone: true, continueCursor: "" });

/** `opts`, asking for at most `max` rows. */
export const capped = <T extends { numItems: number }>(opts: T, max: number) => ({ ...opts, numItems: Math.min(opts.numItems, max) });

/** One batch of an hourly cleanup (crons.ts): `forget`s up to `max` rows of `due`, then runs `again` if it was full. */
export async function sweepExpired<T>(ctx: MutationCtx, due: { take(n: number): Promise<T[]> }, forget: (row: T) => Promise<unknown>, again: FunctionReference<"mutation", "internal">, max = 500) {
	const rows = await due.take(max);
	for (const row of rows) await forget(row);
	if (rows.length === max) await ctx.scheduler.runAfter(0, again, {});
}

/** Agent tools return expected problems to the model. */
export async function asToolResult<Result>(fn: () => Promise<Result>): Promise<Result | { error: string }> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof ConvexError) return { error: String(e.data) };
		throw e;
	}
}

/** A custom or retained skill's instructions, including while its row is in Archive. */
export const skillOf = (install: Doc<"skillInstalls">): Skill | undefined => install.custom
	? customSkill(install.skillId, install.custom, install.custom.version)
	: install.definition;

export const canSeeSkill = (userId: Id<"users"> | undefined, install: Doc<"skillInstalls">) => install.audience === "team" || (install.audience === "personal" && !!userId && install.ownerId === userId);

/** Live retained skills, then custom skills, oldest first within each group. */
export async function installedSkills(ctx: QueryCtx, workspaceId: Id<"workspaces">, userId: Id<"users">, acting?: Member): Promise<Skill[]> {
	const installs = (await ctx.db.query("skillInstalls").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect())
		.filter((i) => !i.archived && canSeeSkill(userId, i)).sort((a, b) => a._creationTime - b._creationTime);
	const member = acting ?? await memberOf(ctx, userId, workspaceId);
	if (!member) return [];
	const skills: Skill[] = [];
	for (const install of [...installs.filter((i) => !i.custom), ...installs.filter((i) => i.custom)]) {
		const skill = skillOf(install);
		if (skill && await readArtifact(ctx, member, install, install.audience === "personal" ? install.ownerId : undefined)) skills.push(skill);
	}
	return skills;
}

/** Someone's `preferences` row, if they've saved any. */
export const preferencesOf = (ctx: QueryCtx, userId: Id<"users">) =>
	ctx.db
		.query("preferences")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.first();

/** Display names for a set of people, falling back to email. */
export async function namesOf(ctx: QueryCtx, userIds: Id<"users">[]) {
	const names = new Map<Id<"users">, string>();
	for (const id of new Set(userIds)) names.set(id, await nameOf(ctx, id));
	return names;
}

export const nameOf = async (ctx: QueryCtx, userId: Id<"users">) => (await personOf(ctx, userId)).name;

/** Someone's display name and photo (a storage id: images.ts turns it into a URL). */
export async function personOf(ctx: QueryCtx, userId: Id<"users">): Promise<{ name: string; image?: Id<"_storage"> }> {
	const user = await ctx.db.get(userId);
	// Erased accounts keep a scrubbed row (workspace.eraseAccount), whatever is left to clean up.
	if (!user || user.erasedAt) return { name: "Former member" };
	const prefs = await preferencesOf(ctx, userId);
	return { name: prefs?.displayName || user.email || "Former member", image: prefs?.image };
}

/** Someone's time zone: the one they picked, else their computer's, else UTC. */
export async function timeZoneOf(ctx: QueryCtx, userId: Id<"users">) {
	const prefs = await preferencesOf(ctx, userId);
	return resolveTimeZone(prefs?.timeZone, prefs?.deviceTimeZone);
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** `bytes` random bytes as hex. */
export const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

/** The id of something a person made (a skill or automation): "custom-" and 12 hex characters. */
export const newCustomId = () => `custom-${randomHex(6)}`;
