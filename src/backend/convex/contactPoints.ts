import { can, localPartError, normalizeEmail, suggestLocalPart } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { emailDomain, emailProvider, smsProvider, smsWebhookUrl } from "./channelProviders";
import { mutation, query } from "./functions";
import { type Member, checkPermission, getMember, liveWorkspace, memberOf, requireAgent, requireLiveAgent, requirePermission } from "./lib";

// An agent's own email address and phone number: how people outside the workspace reach it. Shown in
// the Contact section of its page; people with agents.manage add and remove them (agents too, through
// agents.manage add_contact / remove_contact, which always ask). What arrives lands in Inbox (inbox.ts).
// A number is bought from the provider and released when it's removed, or when its agent is deleted
// forever or its workspace deleted or reset (lifecycle.ts), so nobody pays for a number nothing uses.

export type ContactKind = Doc<"contactPoints">["kind"];

const contactOf = (ctx: MutationCtx | Parameters<typeof getMember>[0], agentId: Id<"agents">, kind: ContactKind) =>
	ctx.db.query("contactPoints").withIndex("by_agent", (q) => q.eq("agentId", agentId).eq("kind", kind)).first();

/** An agent's address and number, and whether this server offers each. */
export const forAgent = query({
	args: { agentId: v.id("agents") },
	handler: async (ctx, { agentId }) => {
		const member = await getMember(ctx);
		if (!member) return null;
		await requireAgent(ctx, member, agentId);
		const shown = (row: Doc<"contactPoints"> | null) => row && { address: row.address, status: row.status, error: row.error ?? null, areaCode: row.areaCode ?? null };
		return {
			email: shown(await contactOf(ctx, agentId, "email")),
			phone: shown(await contactOf(ctx, agentId, "phone")),
			/** What this server can do: unset keys mean the feature isn't offered (channelProviders.ts). */
			available: { email: !!emailDomain() && !!emailProvider(), phone: !!smsProvider() },
			domain: emailDomain(),
		};
	},
});

export const add = mutation({
	args: { agentId: v.id("agents"), kind: v.union(v.literal("email"), v.literal("phone")), name: v.optional(v.string()), areaCode: v.optional(v.string()) },
	handler: async (ctx, args) => addContact(ctx, await requirePermission(ctx, "agents.manage"), args),
});

export const remove = mutation({
	args: { agentId: v.id("agents"), kind: v.union(v.literal("email"), v.literal("phone")) },
	handler: async (ctx, args) => removeContact(ctx, await requirePermission(ctx, "agents.manage"), args.agentId, args.kind),
});

/**
 * Gives an agent its email address (on the server's domain, `name` before the @) or starts buying it a
 * number (in `areaCode`, else anywhere in the US). One of each per agent; an address is never shared.
 * Returns the address, or "getting" while a number is bought.
 */
export async function addContact(ctx: MutationCtx, member: Member, { agentId, kind, name, areaCode }: { agentId: Id<"agents">; kind: ContactKind; name?: string; areaCode?: string }) {
	checkPermission(member, "agents.manage");
	const agent = await requireLiveAgent(ctx, member, agentId);
	const existing = await contactOf(ctx, agentId, kind);
	if (existing && existing.status !== "failed") throw new ConvexError(kind === "email" ? "It already has an email address. Remove it first." : "It already has a phone number. Release it first.");
	if (existing) await ctx.db.delete(existing._id);
	if (kind === "email") {
		const domain = emailDomain();
		if (!domain || !emailProvider()) throw new ConvexError("Email isn't set up on this server yet.");
		const local = normalizeEmail(name || suggestLocalPart(agent.name, crypto.randomUUID().slice(0, 4)));
		const problem = localPartError(local);
		if (problem) throw new ConvexError(problem);
		const address = `${local}@${domain}`;
		const taken = await ctx.db.query("contactPoints").withIndex("by_address", (q) => q.eq("kind", "email").eq("address", address)).first();
		if (taken) throw new ConvexError(`${address} is taken. Pick another.`);
		await ctx.db.insert("contactPoints", { workspaceId: member.workspaceId, agentId, kind, address, status: "active", createdBy: member.userId });
		return address;
	}
	if (!smsProvider()) throw new ConvexError("Texting isn't set up on this server yet.");
	if (areaCode !== undefined && !/^\d{3}$/.test(areaCode)) throw new ConvexError("An area code is 3 digits.");
	const id = await ctx.db.insert("contactPoints", { workspaceId: member.workspaceId, agentId, kind, address: "", status: "getting", createdBy: member.userId, ...(areaCode && { areaCode }) });
	await ctx.scheduler.runAfter(0, internal.contactPoints.buyNumber, { id });
	return "getting";
}

/** Takes an agent's address or number away. A number is released: it can't be got back. Conversations stay in Inbox. */
export async function removeContact(ctx: MutationCtx, member: Member, agentId: Id<"agents">, kind: ContactKind) {
	checkPermission(member, "agents.manage");
	await requireAgent(ctx, member, agentId);
	const row = await contactOf(ctx, agentId, kind);
	if (!row) throw new ConvexError(kind === "email" ? "It has no email address." : "It has no phone number.");
	await dropContact(ctx, row);
}

/** Deletes the row, releasing its number with the provider. Also run by the lifecycle cascades. */
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
		if (!row.allowed) return void (await ctx.runMutation(internal.contactPoints.failed, { id, error: "The agent or the person getting its number is no longer available." }));
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
		if (row?.status !== "getting") return null;
		const agent = await ctx.db.get(row.agentId);
		const member = await memberOf(ctx, row.createdBy, row.workspaceId);
		return { ...row, allowed: !!agent && !agent.archived && !!member && can(member, "agents.manage") && !!(await liveWorkspace(ctx, row.workspaceId)) };
	},
});

/**
 * Saves a bought number. If its row went meanwhile (removed, its agent or workspace deleted), the number
 * is released straight away: nothing would use it, and it costs money every month.
 */
export const bought = internalMutation({
	args: { id: v.id("contactPoints"), providerId: v.string(), number: v.string() },
	handler: async (ctx, { id, providerId, number }) => {
		const row = await ctx.db.get(id);
		const agent = row && (await ctx.db.get(row.agentId));
		if (row?.status === "active" && row.providerId === providerId && row.address === number) return;
		if (!row || row.status !== "getting" || !agent || agent.archived || !(await liveWorkspace(ctx, row.workspaceId))) {
			await ctx.scheduler.runAfter(0, internal.contactPoints.releaseNumber, { providerId });
			if (row?.status === "getting") await ctx.db.patch(id, { status: "failed", error: "The agent is no longer available." });
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
