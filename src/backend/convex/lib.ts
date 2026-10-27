import {
	type Actor,
	type Permission,
	type Skill,
	can,
	customSkill,
	deniedMessage,
	resolveTimeZone,
} from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { legacySkills } from "./legacyCatalogs";
import type { Id } from "./_generated/dataModel";
import type { Requested } from "./functions";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export interface Member {
	/** The `members` row. */
	id: Id<"members">;
	userId: Id<"users">;
	workspaceId: Id<"workspaces">;
	role: Actor["role"];
}

export const toActor = (m: Member): Actor => ({ userId: m.userId, role: m.role });

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
	return row && !(await erased(ctx, userId)) && (await liveWorkspace(ctx, workspaceId)) ? { id: row._id, userId, workspaceId, role: row.role } : null;
}

/** Whether their account was erased (workspace.eraseAccount). */
export const erased = async (ctx: QueryCtx, userId: Id<"users">) => !!(await ctx.db.get(userId))?.erasedAt;

/** Whether someone besides `except` owns it. An erased owner doesn't count: their membership is on its way out. */
export async function hasLiveOwner(ctx: QueryCtx, workspaceId: Id<"workspaces">, except?: Id<"users">) {
	for await (const row of ctx.db.query("members").withIndex("by_role", (q) => q.eq("workspaceId", workspaceId).eq("role", "owner")))
		if (row.userId !== except && !(await erased(ctx, row.userId))) return true;
	return false;
}

/** A workspace that exists and isn't being deleted. Deleting one ends every access to it at once. */
export async function liveWorkspace(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const workspace = await ctx.db.get(workspaceId);
	return workspace && !workspace.deleting ? workspace : null;
}

/**
 * Where apps from before workspace switching act, since they send no workspace: the first
 * workspace the person joined, pinned once (legacyWorkspaces). Fails closed: after they leave
 * it, those apps act nowhere, never in another workspace. Someone pinned before the table
 * existed (the migration backfills them) can only have one workspace, so that one is theirs.
 * COMPAT(0.1.0-alpha.7): once installs send `workspaceId` (alpha.6), require it and delete this.
 */
export async function legacyMemberOf(ctx: QueryCtx, userId: Id<"users">): Promise<Member | null> {
	const pinned = await ctx.db
		.query("legacyWorkspaces")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.first();
	if (pinned) return memberOf(ctx, userId, pinned.workspaceId);
	const rows = await ctx.db
		.query("members")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.take(2);
	return rows.length === 1 ? memberOf(ctx, userId, rows[0]!.workspaceId) : null;
}

/**
 * Pins their legacy workspace (legacyMemberOf) to the first they joined, unless it's set.
 * Call after adding a membership and before removing one. `to` re-pins (ensure only).
 */
export async function pinLegacyWorkspace(ctx: MutationCtx, userId: Id<"users">, to?: Id<"workspaces">) {
	const pinned = await ctx.db.query("legacyWorkspaces").withIndex("by_user", (q) => q.eq("userId", userId)).first();
	if (to) {
		if (pinned) await ctx.db.patch(pinned._id, { workspaceId: to });
		else await ctx.db.insert("legacyWorkspaces", { userId, workspaceId: to });
		return;
	}
	if (pinned) return;
	const first = await ctx.db
		.query("members")
		.withIndex("by_joined", (q) => q.eq("userId", userId))
		.first();
	if (first) await ctx.db.insert("legacyWorkspaces", { userId, workspaceId: first.workspaceId });
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

/**
 * The signed-in person in the workspace this request is for (`functions.ts` puts it on ctx).
 * Null if they're not in it: a request can only act where its sender is a member.
 */
export async function getMember(ctx: QueryCtx): Promise<Member | null> {
	const userId = await authUserId(ctx);
	if (!userId) return null;
	return memberFor(ctx, userId, (ctx as QueryCtx & Partial<Requested>).workspaceId);
}

/** Their membership in the requested workspace; with none (older apps), their first. */
export const memberFor = (ctx: QueryCtx, userId: Id<"users">, workspaceId: Id<"workspaces"> | undefined) =>
	workspaceId ? memberOf(ctx, userId, workspaceId) : legacyMemberOf(ctx, userId);

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

/** Role check shared by app mutations and operations acting for a turn. */
export function checkPermission(member: Member, permission: Permission): Member {
	if (!can(member.role, permission)) throw new ConvexError(deniedMessage(permission));
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

/** Agent tools return expected problems to the model. */
export async function asToolResult<Result>(fn: () => Promise<Result>): Promise<Result | { error: string }> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof ConvexError) return { error: String(e.data) };
		throw e;
	}
}

/** Skills this workspace uses: retained installs, then ones people made, oldest first. */
export async function installedSkills(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Skill[]> {
	const installs = await ctx.db
		.query("skillInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	const stored = installs.filter((i) => !i.custom).flatMap((i) => {
		const definition = i.definition ?? legacySkills.find((s) => s.id === i.skillId);
		return definition ? [definition] : [];
	});
	const custom = installs
		.filter((i) => i.custom && !i.archived)
		.sort((a, b) => a._creationTime - b._creationTime)
		.map((i) => customSkill(i.skillId, i.custom!, i.custom!.version));
	return [...stored, ...custom];
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

export async function nameOf(ctx: QueryCtx, userId: Id<"users">) {
	const user = await ctx.db.get(userId);
	// Erased accounts keep a scrubbed row (workspace.eraseAccount), whatever is left to clean up.
	if (!user || user.erasedAt) return "Former member";
	const prefs = await preferencesOf(ctx, userId);
	return prefs?.displayName || user.email || "Former member";
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
