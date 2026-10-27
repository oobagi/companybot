import {
	type LockSetting,
	type PermissionDecision,
	type Risk,
	type RuleSetting,
	actionLabel,
	alwaysAllowText,
	builtinTools,
	canUseTool,
	findConnector,
	permissionFor,
	toolGroup,
	toolRisk,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalQuery } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Member, getMember, memberFor, nameOf, requireInWorkspace, requireMember, requirePermission } from "./lib";
import { automationName, followsOthers, installOf } from "./automationOps";
import { riskOf, titleOf, toolsOf } from "./connectorTools";
import { risk } from "./schema";
import { runningTurn } from "./turns";

// Who allowed what (core action-rules.ts `permissionFor`): each person's Always / Never per
// action, Always grants scoped to one automation, and owners' locks. An action is one
// tool on one connector install, or a built-in. Everything is read fresh on every call
// (`check`), so a change applies to the very next call; nothing is cached into a session.
//
// Rules key on the person and the action only, never on a snapshot of content: an
// unrelated change (an edited prompt, a new message) can't void or block one.

/** The connector install an action belongs to. Undefined: a built-in. Null: its connector isn't installed. */
async function connectorInstallOf(ctx: QueryCtx, workspaceId: Id<"workspaces">, action: string) {
	const connectorId = toolGroup(action);
	if (!findConnector(connectorId)) return undefined;
	return (
		(await ctx.db
			.query("connectorInstalls")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("connectorId", connectorId))
			.first()) ?? null
	);
}

const lockOf = async (ctx: QueryCtx, workspaceId: Id<"workspaces">, action: string, scope?: Id<"connectorInstalls">) =>
	(
		await ctx.db
			.query("permissionLocks")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("action", action))
			.collect()
	).find((l) => l.connectorInstallId === scope);

/** One person's rules for one action on this install: their own, and grants for automations. */
const rulesOf = async (ctx: QueryCtx, member: Member, action: string, scope?: Id<"connectorInstalls">) =>
	(
		await ctx.db
			.query("permissionRules")
			.withIndex("by_user", (q) => q.eq("userId", member.userId).eq("action", action))
			.collect()
	).filter((r) => r.workspaceId === member.workspaceId && r.connectorInstallId === scope);

/** One call to decide. `automationInstallId`: the automation this run belongs to; `foreign`: its words aren't the person's (`followsOthers`). */
type Call = { action: string; risk: Risk; automationInstallId?: Id<"automationInstalls">; foreign?: boolean };

/** Whether `member`'s call to `action` runs, asks, or is blocked right now, and the rule that allowed it if one did. */
export async function decideFor(ctx: QueryCtx, member: Member, call: Call): Promise<Decided> {
	return decideWith(ctx, member, await connectorInstallOf(ctx, member.workspaceId, call.action), call);
}

type Decided = {
	decision: PermissionDecision;
	/** The rule that let it run, if one did. */
	rule?: Doc<"permissionRules">;
	lock?: LockSetting;
	/** The person's own rule for the action, if any. */
	own?: Doc<"permissionRules">;
};

/** `decideFor` with the action's connector install already read (`connectorInstallOf`). */
async function decideWith(
	ctx: QueryCtx,
	member: Member,
	install: Doc<"connectorInstalls"> | null | undefined,
	{ action, risk, automationInstallId, foreign }: Call,
): Promise<Decided> {
	// Not installed: its tools can't load anyway. Fall back to the tool's own risk.
	if (install === null) return { decision: permissionFor({ risk }) };
	const scope = install?._id;
	const lock = (await lockOf(ctx, member.workspaceId, action, scope))?.lock;
	const rules = await rulesOf(ctx, member, action, scope);
	const own = rules.find((r) => !r.automationInstallId);
	const grant = automationInstallId ? rules.find((r) => r.automationInstallId === automationInstallId && r.setting === "always") : undefined;
	const decision = permissionFor({ risk, lock, rule: own?.setting, automation: !!grant, foreign });
	const rule = decision.type === "run" ? (decision.via === "always" ? own : decision.via === "automation" ? grant : undefined) : undefined;
	return { decision, rule, lock, own };
}

/** The automation install a turn runs for: its trigger message was posted by an automation. */
export async function automationOfTurn(ctx: QueryCtx, turn: Doc<"agentTurns">) {
	const trigger = await ctx.db.get(turn.triggerId);
	if (!trigger?.automation) return null;
	return installOf(ctx, turn.workspaceId, trigger.automation.id);
}

/** Called by the runner before every call that could ask: the decision, from the rules in force now. */
export const check = internalQuery({
	args: { turnId: v.id("agentTurns"), action: v.string(), risk },
	handler: async (ctx, { turnId, action, risk }) => {
		const { turn, member } = await runningTurn(ctx, turnId);
		const automation = await automationOfTurn(ctx, turn);
		const trigger = await ctx.db.get(turn.triggerId);
		if (trigger?.automation && !automation) throw new ConvexError("This automation was removed. Nothing ran.");
		// Keep the original run's provenance through edits and approval continuations. Old
		// messages lack this snapshot, so fail toward asking rather than trusting their words.
		const foreign = !!automation && ((trigger?.automation?.foreign ?? true) || followsOthers(automation, member.userId));
		const decided = await decideFor(ctx, member, { action, risk, automationInstallId: automation?._id, foreign });
		const { rule } = decided;
		// An automation's run never stops as a whole: only this call waits for the person.
		const decision = decided.decision.type === "ask" && automation ? { ...decided.decision, waitFor: await nameOf(ctx, member.userId) } : decided.decision;
		const allowed =
			rule && decision.type === "run" && decision.via
				? {
						how: decision.via,
						by: rule.userId,
						at: rule.setAt,
						ruleId: rule._id,
						...(decision.via === "automation" && automation && { automation: automationName(automation) }),
					}
				: undefined;
		return { decision, allowed };
	},
});

/**
 * Saves (or clears) a person's rule for one action. Always is refused where the action always asks.
 * `risk`: the held call's own, for tools whose risk depends on the call (`riskFor`).
 */
export async function setRule(
	ctx: MutationCtx,
	member: Member,
	{ action, setting, automationInstallId, risk: callRisk }: { action: string; setting: RuleSetting | "ask"; automationInstallId?: Id<"automationInstalls">; risk?: Risk },
) {
	const install = await connectorInstallOf(ctx, member.workspaceId, action);
	if (install === null) throw new ConvexError("Install the connector first.");
	if (install && !install.roles.includes(member.role)) throw new ConvexError("Your role can't use this connector.");
	if (install === undefined && !builtinTools.some((t) => t.id === action)) throw new ConvexError("Unknown action.");
	const scope = install?._id;
	const risk = callRisk ?? (await riskOf(ctx, member.workspaceId, action));
	// Acting as you only ever asks in others' automations, so it's only ever allowed for one.
	if (risk === "inside" && !automationInstallId) throw new ConvexError("This only asks in automations someone else wrote; allow it there.");
	if (setting === "always") {
		const { decision } = await decideFor(ctx, member, { action, risk, foreign: !!automationInstallId });
		if (decision.type === "ask" && !decision.canAlways) throw new ConvexError("This action always asks, so it can't be set to Always.");
		if (decision.type === "deny") throw new ConvexError(decision.by === "owner" ? "An owner blocked this action." : "Clear Never first.");
	}
	const existing = (await rulesOf(ctx, member, action, scope)).find((r) => r.automationInstallId === automationInstallId);
	if (existing) await ctx.db.delete(existing._id);
	if (setting !== "ask")
		await ctx.db.insert("permissionRules", {
			workspaceId: member.workspaceId,
			userId: member.userId,
			action,
			connectorInstallId: scope,
			automationInstallId,
			setting,
			setAt: Date.now(),
		});
}

/** The workspace a request is for, if they're in it (actions can't read the database). */
export const workspaceOf = internalQuery({
	args: { userId: v.id("users"), workspaceId: v.optional(v.id("workspaces")) },
	handler: async (ctx, { userId, workspaceId }) => (await memberFor(ctx, userId, workspaceId))?.workspaceId ?? null,
});

/** Forgets one person's grants for an automation: they turned it off for themselves. */
export async function forgetAutomationGrants(ctx: MutationCtx, installId: Id<"automationInstalls">, userId: Id<"users">) {
	for await (const row of ctx.db.query("permissionRules").withIndex("by_automation", (q) => q.eq("automationInstallId", installId)))
		if (row.userId === userId) await ctx.db.delete(row._id);
}

// ---- The app ----

type Action = {
	action: string;
	/** Its name for people: "Send SMS". */
	label: string;
	/** The connector's name, or null for built-ins. */
	service: string | null;
	connectorId: string | null;
	title?: string;
	description: string;
	risk: Risk;
	/** The owner's lock, if any. */
	lock: LockSetting | null;
	/** Your own rule. */
	setting: RuleSetting | "ask";
	/** What happens when an agent acting for you calls it (outside automations). */
	result: PermissionDecision["type"];
	canAlways: boolean;
	/** What "Always" means here, in plain words (the card says the same). */
	alwaysText: string;
};

/**
 * Every action agents can take here: installed connectors' tools (as last listed) and built-ins
 * that ask in ordinary chat, with the person's settings for each.
 */
async function actionsFor(ctx: QueryCtx, member: Member): Promise<Action[]> {
	const installs = await ctx.db
		.query("connectorInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
		.collect();
	const defs: { action: string; title?: string; description: string; risk: Risk; install?: Doc<"connectorInstalls"> }[] = builtinTools
		.filter((t) => canUseTool(member, t) && toolRisk(t) !== "none" && toolRisk(t) !== "inside")
		.map((t) => ({ action: t.id, title: t.title, description: t.description, risk: toolRisk(t) }));
	for (const install of installs) {
		if (!findConnector(install.connectorId)) continue;
		for (const t of await toolsOf(ctx, member.workspaceId, install.connectorId))
			defs.push({ action: `${install.connectorId}.${t.name}`, title: t.title, description: t.description, risk: t.risk, install });
	}
	return Promise.all(
		defs.map(async ({ install, ...d }) => {
			const connector = findConnector(toolGroup(d.action)) ?? null;
			const { decision, lock, own } = await decideWith(ctx, member, install, { action: d.action, risk: d.risk });
			const forced = lock === "ask" || lock === "block" || (d.risk === "locked" && lock !== "none");
			const action: Action = {
				...d,
				label: actionLabel(d.action, d.title),
				service: connector?.name ?? null,
				connectorId: connector?.id ?? null,
				lock: lock ?? null,
				setting: own?.setting ?? "ask",
				result: decision.type,
				canAlways: d.risk !== "none" && !forced,
				// Shown beside its own Ask / Always / Never, so no pointer to Settings.
				alwaysText: alwaysAllowText(d.action, connector, { title: d.title, whereToChange: false }),
			};
			return action;
		}),
	);
}

/** The actions you can set: optionally one connector's. */
export const actions = query({
	args: { connectorId: v.optional(v.string()) },
	handler: async (ctx, { connectorId }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const all = await actionsFor(ctx, member);
		return connectorId ? all.filter((a) => a.connectorId === connectorId) : all;
	},
});

/** Your Always and Never rules, and what you allowed for automations. For Settings → Your preferences. */
export const mine = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return null;
		const rows = (
			await ctx.db
				.query("permissionRules")
				.withIndex("by_user", (q) => q.eq("userId", member.userId))
				.collect()
		).filter((r) => r.workspaceId === member.workspaceId);
		return Promise.all(
			rows.map(async (r) => {
				const connector = findConnector(toolGroup(r.action)) ?? null;
				const automation = r.automationInstallId ? await ctx.db.get(r.automationInstallId) : null;
				const name = automation ? automationName(automation) : undefined;
				const title = await titleOf(ctx, member.workspaceId, r.action);
				return {
					_id: r._id,
					action: r.action,
					label: actionLabel(r.action, title),
					service: connector?.name ?? null,
					setting: r.setting,
					setAt: r.setAt,
					automation: automation ? { id: automation.automationId, name: name! } : null,
					// This is Settings → Your preferences already, so no pointer to it.
					text:
						r.setting === "always"
							? alwaysAllowText(r.action, connector, { automation: name, title, whereToChange: false })
							: "Never: agents can't do this for you.",
				};
			}),
		);
	},
});

/** Sets your own Ask / Always / Never for one action. Applies from the next call. */
export const set = mutation({
	args: { action: v.string(), setting: v.union(v.literal("ask"), v.literal("always"), v.literal("never")) },
	handler: async (ctx, { action, setting }) => setRule(ctx, await requireMember(ctx), { action, setting }),
});

/** Removes one of your rules (an automation grant, from Settings). */
export const remove = mutation({
	args: { ruleId: v.id("permissionRules") },
	handler: async (ctx, { ruleId }) => {
		const member = await requireMember(ctx);
		const row = requireInWorkspace(member, await ctx.db.get(ruleId), "Rule");
		if (row.userId === member.userId) await ctx.db.delete(ruleId);
	},
});

/** Owners: lock an action for everyone. Null goes back to the default. */
export const setLock = mutation({
	args: { action: v.string(), lock: v.union(v.literal("ask"), v.literal("block"), v.literal("none"), v.null()) },
	handler: async (ctx, { action, lock }) => {
		const member = await requirePermission(ctx, "actions.lock");
		const install = await connectorInstallOf(ctx, member.workspaceId, action);
		if (install === null) throw new ConvexError("Install the connector first.");
		if (install === undefined && !builtinTools.some((t) => t.id === action)) throw new ConvexError("Unknown action.");
		const existing = await lockOf(ctx, member.workspaceId, action, install?._id);
		if (existing) await ctx.db.delete(existing._id);
		if (lock)
			await ctx.db.insert("permissionLocks", {
				workspaceId: member.workspaceId,
				action,
				connectorInstallId: install?._id,
				lock,
				setBy: member.userId,
				setAt: Date.now(),
			});
	},
});
