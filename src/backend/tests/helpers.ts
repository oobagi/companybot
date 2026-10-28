import { seedLegacyRecords, scribe } from "./legacyFixtures";
import prosemirrorSync from "@convex-dev/prosemirror-sync/test";
import { convexTest } from "convex-test";
import { vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { person } from "./person";

export const modules = import.meta.glob(["../convex/**/*.ts", "../convex/_generated/*.js"]);

/** Raw calls as `userId`. Convex Auth reads the user id from the token subject. */
export const identityOf = (t: ReturnType<typeof convexTest>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session` });

/**
 * A signed-in person, with their first workspace open. The main agent's welcome (onboarding.ts)
 * is taken back so tests start from a quiet #general, unless `welcome` keeps it.
 */
export async function signIn(t: ReturnType<typeof convexTest>, email: string, { welcome = false } = {}) {
	const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
	const identity = identityOf(t, userId);
	const before = new Set(await t.run(async (ctx) => (await ctx.db.query("chatMessages").collect()).map((m) => m._id)));
	await person(identity).mutation(api.workspace.ensure);
	const first = await t.run(async (ctx) => (await ctx.db.query("members").collect()).find((m) => m.userId === userId));
	if (!welcome)
		await t.run(async (ctx) => {
			for (const m of await ctx.db.query("chatMessages").collect())
				// A welcome is done the moment it's posted; a reply started meanwhile is still streaming.
				if (!before.has(m._id) && m.authorAgentId && m.status === "done" && !m.stats) await ctx.db.delete(m._id);
		});
	return Object.assign(person(identity, first?.workspaceId), { userId });
}

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

export async function ownerAndMember() {
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
