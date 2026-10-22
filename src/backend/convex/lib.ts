import type { Actor } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { skillCatalog } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

export interface Member {
	userId: Id<"users">;
	workspaceId: Id<"workspaces">;
	role: Actor["role"];
}

export const toActor = (m: Member): Actor => ({ userId: m.userId, role: m.role });

/** Reads membership fresh, so role changes and removals apply right away (even mid-reply). */
export async function memberOf(ctx: QueryCtx, userId: Id<"users">): Promise<Member | null> {
	const row = await ctx.db
		.query("members")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.first();
	return row ? { userId, workspaceId: row.workspaceId, role: row.role } : null;
}

export async function getMember(ctx: QueryCtx): Promise<Member | null> {
	const userId = await getAuthUserId(ctx);
	return userId ? memberOf(ctx, userId) : null;
}

export async function requireMember(ctx: QueryCtx): Promise<Member> {
	const member = await getMember(ctx);
	if (!member) throw new ConvexError("Sign in to a workspace first.");
	return member;
}

export async function requireOwner(ctx: QueryCtx): Promise<Member> {
	const member = await requireMember(ctx);
	if (member.role !== "owner") throw new ConvexError("Only owners can do that.");
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

/** Skills this workspace installed, in catalog order. */
export async function installedSkills(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const installs = await ctx.db
		.query("skillInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	const ids = new Set(installs.map((i) => i.skillId));
	return skillCatalog.filter((s) => ids.has(s.id));
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

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
