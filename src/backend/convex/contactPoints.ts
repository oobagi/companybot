import { can, localPartError, normalizeEmail, suggestLocalPart } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { emailDomain, emailProvider, smsProvider, smsWebhookUrl } from "./channelProviders";
import { mutation, query } from "./functions";
import { type Member, checkPermission, getMember, liveWorkspace, requireAgent, requireInWorkspace, requireLiveAgent, requirePermission } from "./lib";

// The workspace's email addresses and phone numbers: how people outside reach the business. Settings →
// Email and phone lists them; people with inbox.setup add and remove them and pick the agent that answers
// each (or none: staff answer). Agents do the same through inbox.manage, always asking first. What
// arrives lands in Inbox (inbox.ts), and every reply goes out from the address it came to, under the
// name of whoever wrote it. A number is bought from the provider and released when it's removed or its
// workspace deleted or reset (lifecycle.ts), so nobody pays for a number nothing uses. An agent deleted
// for good leaves its addresses with nobody answering them.

export type ContactKind = Doc<"contactPoints">["kind"];

/** Addresses and numbers per kind, a workspace at most: plenty for teams, and a cap on what numbers cost. */
export const POINTS_MAX = 10;

const shown = async (ctx: Parameters<typeof getMember>[0], row: Doc<"contactPoints">) => {
	const agent = row.agentId && (await ctx.db.get(row.agentId));
	return {
		id: row._id,
		kind: row.kind,
		address: row.address,
		status: row.status,
		error: row.error ?? null,
		areaCode: row.areaCode ?? null,
		/** Who answers new conversations to it; null: staff do. An agent in Archive answers nothing, so it shows as none. */
		agent: agent && !agent.archived ? { id: agent._id, name: agent.name } : null,
	};
};

/** The workspace's addresses and numbers, oldest first, and what this server offers. For anyone in Inbox or setting it up. */
export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member || !(can(member, "inbox.use") || can(member, "inbox.setup"))) return null;
		const rows = await ctx.db.query("contactPoints").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)).take(POINTS_MAX * 2);
		return {
			points: await Promise.all(rows.map((row) => shown(ctx, row))),
			/** What this server can do: unset keys mean the feature isn't offered (channelProviders.ts). */
			available: { email: !!emailDomain() && !!emailProvider(), phone: !!smsProvider() },
			domain: emailDomain(),
		};
	},
});

/** The addresses and numbers an agent answers, for its page and details. */
export const forAgent = query({
	args: { agentId: v.id("agents") },
	handler: async (ctx, { agentId }) => {
		const member = await getMember(ctx);
		if (!member) return null;
		await requireAgent(ctx, member, agentId);
		const rows = await ctx.db.query("contactPoints").withIndex("by_agent", (q) => q.eq("agentId", agentId)).take(POINTS_MAX * 2);
		return rows.filter((r) => r.status === "active" && r.workspaceId === member.workspaceId).map((r) => ({ kind: r.kind, address: r.address }));
	},
});

const kindArg = v.union(v.literal("email"), v.literal("phone"));

export const add = mutation({
	args: { kind: kindArg, name: v.optional(v.string()), areaCode: v.optional(v.string()), agentId: v.optional(v.id("agents")) },
	handler: async (ctx, args) => addPoint(ctx, await requirePermission(ctx, "inbox.setup"), args),
});

export const remove = mutation({
	args: { id: v.id("contactPoints") },
	handler: async (ctx, { id }) => removePoint(ctx, await requirePermission(ctx, "inbox.setup"), id),
});

export const setAgent = mutation({
	args: { id: v.id("contactPoints"), agentId: v.union(v.id("agents"), v.null()) },
	handler: async (ctx, { id, agentId }) => setPointAgent(ctx, await requirePermission(ctx, "inbox.setup"), id, agentId),
});

/** Tries buying a number again, after it failed. */
export const retry = mutation({
	args: { id: v.id("contactPoints") },
	handler: async (ctx, { id }) => {
		const member = await requirePermission(ctx, "inbox.setup");
		const row = requireInWorkspace(member, await ctx.db.get(id), "Number");
		if (row.kind !== "phone" || row.status !== "failed") return;
		await ctx.db.patch(row._id, { status: "getting", error: undefined });
		await ctx.scheduler.runAfter(0, internal.contactPoints.buyNumber, { id: row._id });
	},
});

/** One of the workspace's addresses or numbers, by its address (as written, or formatted). */
export async function pointByAddress(ctx: Parameters<typeof getMember>[0], workspaceId: Id<"workspaces">, kind: ContactKind, address: string) {
	const row = await ctx.db.query("contactPoints").withIndex("by_address", (q) => q.eq("kind", kind).eq("address", address)).first();
	return row?.workspaceId === workspaceId ? row : null;
}

/**
 * Adds an email address (on the server's domain, `name` before the @) or starts buying a number (in
 * `areaCode`, else anywhere in the US), answered by `agentId` or, without one, by staff. An address is
 * never shared between workspaces. Returns the address, or "getting" while a number is bought.
 */
export async function addPoint(ctx: MutationCtx, member: Member, { kind, name, areaCode, agentId }: { kind: ContactKind; name?: string; areaCode?: string; agentId?: Id<"agents"> }) {
	checkPermission(member, "inbox.setup");
	if (agentId) await requireLiveAgent(ctx, member, agentId);
	const mine = await ctx.db.query("contactPoints").withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId)).take(POINTS_MAX * 2);
	if (mine.filter((r) => r.kind === kind).length >= POINTS_MAX) throw new ConvexError(kind === "email" ? `A workspace has at most ${POINTS_MAX} email addresses.` : `A workspace has at most ${POINTS_MAX} phone numbers.`);
	if (kind === "email") {
		const domain = emailDomain();
		if (!domain || !emailProvider()) throw new ConvexError("Email isn't set up on this server yet.");
		const workspace = await ctx.db.get(member.workspaceId);
		const local = normalizeEmail(name || suggestLocalPart(workspace?.name ?? "", crypto.randomUUID().slice(0, 4)));
		const problem = localPartError(local);
		if (problem) throw new ConvexError(problem);
		const address = `${local}@${domain}`;
		const taken = await ctx.db.query("contactPoints").withIndex("by_address", (q) => q.eq("kind", "email").eq("address", address)).first();
		if (taken) throw new ConvexError(`${address} is taken. Pick another.`);
		await ctx.db.insert("contactPoints", { workspaceId: member.workspaceId, kind, address, status: "active", createdBy: member.userId, ...(agentId && { agentId }) });
		return address;
	}
	if (!smsProvider()) throw new ConvexError("Texting isn't set up on this server yet.");
	if (areaCode !== undefined && !/^\d{3}$/.test(areaCode)) throw new ConvexError("An area code is 3 digits.");
	const id = await ctx.db.insert("contactPoints", { workspaceId: member.workspaceId, kind, address: "", status: "getting", createdBy: member.userId, ...(areaCode && { areaCode }), ...(agentId && { agentId }) });
	await ctx.scheduler.runAfter(0, internal.contactPoints.buyNumber, { id });
	return "getting";
}

/** Takes an address or number away. A number is released: it can't be got back. Its conversations stay in Inbox, unable to reply. */
export async function removePoint(ctx: MutationCtx, member: Member, id: Id<"contactPoints">) {
	checkPermission(member, "inbox.setup");
	await dropContact(ctx, requireInWorkspace(member, await ctx.db.get(id), "Address"));
}

/** Picks who answers new conversations to it: an agent, or (null) staff. Conversations already going keep who has them. */
export async function setPointAgent(ctx: MutationCtx, member: Member, id: Id<"contactPoints">, agentId: Id<"agents"> | null) {
	checkPermission(member, "inbox.setup");
	const row = requireInWorkspace(member, await ctx.db.get(id), "Address");
	if (agentId) await requireLiveAgent(ctx, member, agentId);
	await ctx.db.patch(row._id, { agentId: agentId ?? undefined });
}

/** Deletes the row, releasing its number with the provider. */
export async function dropContact(ctx: MutationCtx, row: Doc<"contactPoints">) {
	await releaseLater(ctx, row);
	await ctx.db.delete(row._id);
}

/** Releases its number with the provider, if it has one. The lifecycle cascades call this just before deleting the row. */
export async function releaseLater(ctx: MutationCtx, row: Doc<"contactPoints">) {
	if (row.kind === "phone" && row.providerId) await ctx.scheduler.runAfter(0, internal.contactPoints.releaseNumber, { providerId: row.providerId });
}

// ---- Buying and releasing numbers ----

export const buyNumber = internalAction({
	args: { id: v.id("contactPoints") },
	handler: async (ctx, { id }) => {
		const row = await ctx.runQuery(internal.contactPoints.pending, { id });
		if (!row) return;
		const provider = smsProvider();
		if (!provider) return void (await ctx.runMutation(internal.contactPoints.failed, { id, error: "Texting isn't set up on this server." }));
		try {
			const bought = await provider.buy({ areaCode: row.areaCode, smsUrl: smsWebhookUrl() });
			await ctx.runMutation(internal.contactPoints.bought, { id, providerId: bought.id, number: bought.number });
		} catch (e) {
			await ctx.runMutation(internal.contactPoints.failed, { id, error: e instanceof Error ? e.message : String(e) });
		}
	},
});

export const pending = internalQuery({
	args: { id: v.id("contactPoints") },
	handler: async (ctx, { id }) => {
		const row = await ctx.db.get(id);
		return row?.status === "getting" ? row : null;
	},
});

/**
 * Saves a bought number. If its row went meanwhile (removed, or its workspace deleted), the number
 * is released straight away: nothing would use it, and it costs money every month.
 */
export const bought = internalMutation({
	args: { id: v.id("contactPoints"), providerId: v.string(), number: v.string() },
	handler: async (ctx, { id, providerId, number }) => {
		const row = await ctx.db.get(id);
		if (!row || row.status !== "getting" || !(await liveWorkspace(ctx, row.workspaceId))) {
			await ctx.scheduler.runAfter(0, internal.contactPoints.releaseNumber, { providerId });
			return;
		}
		await ctx.db.patch(id, { status: "active", address: number, providerId, error: undefined });
	},
});

export const failed = internalMutation({
	args: { id: v.id("contactPoints"), error: v.string() },
	handler: async (ctx, { id, error }) => {
		const row = await ctx.db.get(id);
		if (row?.status === "getting") await ctx.db.patch(id, { status: "failed", error: error.slice(0, 300) });
	},
});

/** Gives a number back to the provider. Retried a few times, since a number left behind keeps costing. */
export const releaseNumber = internalAction({
	args: { providerId: v.string(), attempt: v.optional(v.number()) },
	handler: async (ctx, { providerId, attempt = 0 }) => {
		const provider = smsProvider();
		if (!provider) return void console.error(`Can't release ${providerId}: texting isn't set up on this server.`);
		try {
			await provider.release(providerId);
		} catch (e) {
			if (attempt >= 4) return void console.error(`Couldn't release ${providerId}: ${e instanceof Error ? e.message : e}`);
			await ctx.scheduler.runAfter(60_000 * 2 ** attempt, internal.contactPoints.releaseNumber, { providerId, attempt: attempt + 1 });
		}
	},
});
