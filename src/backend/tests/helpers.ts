import { seedLegacyRecords, scribe } from "./legacyFixtures";
import prosemirrorSync from "@convex-dev/prosemirror-sync/test";
import { convexTest } from "convex-test";
import { vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { person } from "./person";

export const modules = import.meta.glob(["../convex/**/*.ts", "../convex/_generated/*.js"]);

/** A signed-in person, with their first workspace open. Convex Auth reads the user id from the token subject. */
export async function signIn(t: ReturnType<typeof convexTest>, email: string) {
	const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
	const identity = t.withIdentity({ subject: `${userId}|session` });
	await person(identity).mutation(api.workspace.ensure);
	const first = await t.run(async (ctx) => (await ctx.db.query("members").collect()).find((m) => m.userId === userId));
	await skipWelcomes(t);
	return Object.assign(person(identity, first?.workspaceId), { userId });
}

/**
 * Takes back the welcomes agents just started (onboarding.ts), so tests start from a quiet
 * #general. Tests of the welcome itself call `api.workspace.ensure` directly.
 */
export const skipWelcomes = (t: ReturnType<typeof convexTest>) =>
	t.run(async (ctx) => {
		for (const turn of await ctx.db.query("agentTurns").collect()) {
			if (!turn.welcome) continue;
			if (turn.replyId) await ctx.db.delete(turn.replyId);
			if (turn.sessionId) await ctx.db.delete(turn.sessionId);
			await ctx.db.delete(turn._id);
		}
	});

/** The workspace a person's calls act in. */
export const workspaceOf = async (as: As) => (await as.query(api.workspace.me))!.workspaceId!;

/** A person's calls as the app makes them: each carries the workspace that window has open. */
export const inWorkspace = (as: As, workspaceId: Id<"workspaces">) => as.in(workspaceId);

/** Gives someone a second workspace of their own, as owner. */
export async function sideWorkspace(t: ReturnType<typeof convexTest>, email: string, name = "Side gig") {
	return t.run(async (ctx) => {
		const userId = (await ctx.db.query("users").collect()).find((u) => u.email === email)!._id;
		const workspaceId = await ctx.db.insert("workspaces", { name, version: 1 });
		await ctx.db.insert("members", { workspaceId, userId, role: "owner", email: email.trim().toLowerCase() });
		return { userId, workspaceId };
	});
}

/** The workspace's agents by name. */
export async function agentsOf(as: As) {
	const list = await as.query(api.agents.list);
	const byName = (name: string) => list.find((a) => a.name === name)!;
	return { list, companybot: byName("Companybot"), scribe: byName("Scribe") };
}

/** A fresh backend, with the components it uses. */
export function newTest() {
	const t = convexTest({ schema, modules, transactionLimits: true });
	prosemirrorSync.register(t);
	return t;
}

export async function setup() {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	await t.run(async (ctx) => {
		const agentId = await ctx.db.insert("agents", { ...scribe, workspaceId, archived: false, version: 1, updatedBy: owner.userId, updatedAt: Date.now() });
		await ctx.db.insert("agentVersions", { agentId, version: 1, config: scribe, savedBy: owner.userId });
		await seedLegacyRecords(ctx, workspaceId, owner.userId);
	});
	await owner.mutation(api.workspace.invite, { email: "Member@Co.com", role: "member" });
	const member = await signIn(t, "member@co.com");
	return { t, owner, member };
}

export type As = ReturnType<typeof person>;
export const noMentions = { userIds: [], agentIds: [] };
/** Read times are in ms; let the clock move so "after" means after. */
export const tick = () => new Promise((r) => setTimeout(r, 3));
export const meOf = async (as: As) => (await as.query(api.workspace.me))!.userId;
/** #general with its members (chats.get: the list leaves channel members out). */
export const generalOf = async (as: As) =>
	(await as.query(api.chats.get, { chatId: (await as.query(api.chats.list))!.channels.find((c) => c.isDefault)!._id }))!;
export const turnsOf = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("agentTurns").collect());
/** A running turn of `agentId` for `as`, started by mentioning it in `chatId`. Fake timers hold its reply back. */
export async function agentTurn(t: ReturnType<typeof convexTest>, as: As, chatId: Id<"chats">, agentId: Id<"agents">) {
	vi.useFakeTimers();
	const before = await turnsOf(t);
	await as.mutation(api.messages.send, { chatId, text: "hi", mentions: { userIds: [], agentIds: [agentId] } });
	return (await turnsOf(t)).find((x) => !before.some((b) => b._id === x._id))!._id;
}
export const usage = (costUsd: number) => ({
	model: "anthropic/claude-haiku-5.5",
	steps: 1,
	inputTokens: 100,
	cachedInputTokens: 0,
	outputTokens: 20,
	contextTokens: 120,
	costUsd,
	durationMs: 900,
});


/** Runs everything scheduled (cascades, cleanups) until nothing is left. */
export async function settle(t: ReturnType<typeof convexTest>) {
	const fake = vi.isFakeTimers();
	if (!fake) vi.useFakeTimers();
	try {
		await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
	} finally {
		if (!fake) vi.useRealTimers();
	}
}
