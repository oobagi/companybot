import {
	type Actor,
	type Permission,
	type Skill,
	can,
	customSkill,
	deniedMessage,
	resolveTimeZone,
	skillCatalog,
} from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { Requested } from "./functions";
import type { QueryCtx } from "./_generated/server";

export interface Member {
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
	return row ? { userId, workspaceId, role: row.role } : null;
}

/**
 * The first workspace they joined: where apps from before workspace switching act, since
 * they send no workspace. Stable, so another device switching can't move their requests.
 * COMPAT(0.1.0-alpha.7): once installs send `workspaceId` (alpha.6), require it and delete this.
 */
export async function legacyMemberOf(ctx: QueryCtx, userId: Id<"users">): Promise<Member | null> {
	let first: Doc<"members"> | null = null;
	for await (const row of ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)))
		if (!first || row._creationTime < first._creationTime) first = row;
	return first ? { userId, workspaceId: first.workspaceId, role: first.role } : null;
}

/**
 * The signed-in person in the workspace this request is for (`functions.ts` puts it on ctx).
 * Null if they're not in it: a request can only act where its sender is a member.
 */
export async function getMember(ctx: QueryCtx): Promise<Member | null> {
	const userId = await getAuthUserId(ctx);
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
	const member = await requireMember(ctx);
	if (!can(member.role, permission)) throw new ConvexError(deniedMessage(permission));
	return member;
}

/** An agent in the person's workspace. Other workspaces' agents look like they don't exist. */
export async function requireAgent(ctx: QueryCtx, member: Member, agentId: Id<"agents">) {
	const agent = await ctx.db.get(agentId);
	if (!agent || agent.workspaceId !== member.workspaceId) throw new ConvexError("Agent not found.");
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

/** Agent tools return expected problems to the model. */
export async function asToolResult<Result>(fn: () => Promise<Result>): Promise<Result | { error: string }> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof ConvexError) return { error: String(e.data) };
		throw e;
	}
}

/** Skills this workspace installed: library ones in catalog order, then ones people made, oldest first. */
export async function installedSkills(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Skill[]> {
	const installs = await ctx.db
		.query("skillInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	const ids = new Set(installs.filter((i) => !i.custom).map((i) => i.skillId));
	const custom = installs
		.filter((i) => i.custom)
		.sort((a, b) => a._creationTime - b._creationTime)
		.map((i) => customSkill(i.skillId, i.custom!, i.custom!.version));
	return [...skillCatalog.filter((s) => ids.has(s.id)), ...custom];
}

/** Display names for a set of people, falling back to email. */
export async function namesOf(ctx: QueryCtx, userIds: Id<"users">[]) {
	const names = new Map<Id<"users">, string>();
	for (const id of new Set(userIds)) names.set(id, await nameOf(ctx, id));
	return names;
}

export async function nameOf(ctx: QueryCtx, userId: Id<"users">) {
	const prefs = await ctx.db
		.query("preferences")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.first();
	if (prefs?.displayName) return prefs.displayName;
	return (await ctx.db.get(userId))?.email ?? "Someone";
}

/** Someone's time zone: the one they picked, else their computer's, else UTC. */
export async function timeZoneOf(ctx: QueryCtx, userId: Id<"users">) {
	const prefs = await ctx.db
		.query("preferences")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.first();
	return resolveTimeZone(prefs?.timeZone, prefs?.deviceTimeZone);
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** `bytes` random bytes as hex. */
export const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

/** The id of something a person made (a skill or automation): "custom-" and 12 hex characters. */
export const newCustomId = () => `custom-${randomHex(6)}`;
