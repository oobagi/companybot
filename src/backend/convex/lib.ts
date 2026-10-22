import type { Actor } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { skillCatalog } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { role } from "./schema";

export interface Member {
	userId: Id<"users">;
	workspaceId: Id<"workspaces">;
	role: Actor["role"];
}

/** Validator for passing a member into internal functions. */
export const memberArg = v.object({ userId: v.id("users"), workspaceId: v.id("workspaces"), role });

export const toActor = (m: Member): Actor => ({ userId: m.userId, role: m.role });

export async function getMember(ctx: QueryCtx): Promise<Member | null> {
	const userId = await getAuthUserId(ctx);
	if (!userId) return null;
	const row = await ctx.db
		.query("members")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.first();
	return row ? { userId, workspaceId: row.workspaceId, role: row.role } : null;
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

/** Skills this workspace installed, in catalog order. */
export async function installedSkills(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const installs = await ctx.db
		.query("skillInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	const ids = new Set(installs.map((i) => i.skillId));
	return skillCatalog.filter((s) => ids.has(s.id));
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
