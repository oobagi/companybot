import { seedLegacyRecords, scribe } from "./legacyFixtures";
import prosemirrorSync from "@convex-dev/prosemirror-sync/test";
import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { vi } from "vitest";
import type { Permission } from "@companybot/core";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import type { MutationCtx } from "../convex/_generated/server";
import { rolesOf } from "../convex/lib";
import { seedRoles } from "../convex/roles";
import { person } from "./person";

export const modules = import.meta.glob(["../convex/**/*.ts", "../convex/_generated/*.js"]);

/** Raw calls as `userId`. Convex Auth reads the user id from the token subject. */
export const identityOf = (t: ReturnType<typeof convexTest>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session` });

/**
 * A signed-in person, with their first workspace open: the ones that invited them, else "My company"
 * from onboarding (workspace.setUp). The main agent's welcome (onboarding.ts) is taken back so
 * tests start from a quiet #general, unless `welcome` keeps it.
 */
export async function signIn(t: ReturnType<typeof convexTest>, email: string, { welcome = false } = {}) {
	const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
	const identity = identityOf(t, userId);
	const before = new Set(await t.run(async (ctx) => (await ctx.db.query("chatMessages").collect()).map((m) => m._id)));
	await person(identity).mutation(api.workspace.ensure);
	const memberRow = async () => t.run(async (ctx) => (await ctx.db.query("members").collect()).find((m) => m.userId === userId));
	if (!(await memberRow())) await person(identity).mutation(api.workspace.setUp, { displayName: "", name: "My company", invites: [] });
	const first = await memberRow();
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
		await addMember(ctx, { workspaceId, userId, role: "owner", email: email.trim().toLowerCase() });
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
/** A chat's or a thread's messages as the app first shows them: its newest page, in the order shown. */
export const messagesIn = async (as: Pick<As, "query">, args: Omit<FunctionArgs<typeof api.messages.page>, "paginationOpts">) =>
	(await as.query(api.messages.page, { ...args, paginationOpts: { numItems: 200, cursor: null } })).page;
export const noMentions = { userIds: [], agentIds: [] };
/** A chat's activity row: its last message time and running cost (chatOps `activityOf`). */
export const chatActivityOf = (t: ReturnType<typeof newTest>, chatId: Id<"chats">) =>
	t.run(async (ctx) => (await ctx.db.query("chatActivity").withIndex("by_chat", (q) => q.eq("chatId", chatId)).unique())!);
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
type Decision = NonNullable<FunctionArgs<typeof internal.turns.finishReply>["decision"]>;
/**
 * Ends a turn as the runner does (agent.ts): `say` is the message its answer posts; "" posts nothing.
 * Its message goes last in the reply, after `parts`.
 */
export async function finishTurn(
	t: ReturnType<typeof convexTest>,
	turnId: Id<"agentTurns">,
	say: string,
	{ parts = [], usage, ...decision }: { parts?: FunctionArgs<typeof internal.turns.updateReply>["parts"]; usage?: FunctionArgs<typeof internal.turns.finishReply>["usage"] } & Partial<Decision> = {},
) {
	const decided: Decision = { emoji: null, new_point: say ? "Something new" : "", to: "room", message: say, ...decision };
	await t.mutation(internal.turns.updateReply, { turnId, text: say, parts: [...parts, ...(say ? [{ type: "text" as const, text: say }] : [])] });
	await t.mutation(internal.turns.finishReply, { turnId, usage, decision: decided });
}
/** Chats whose `memberCount` isn't their number of seats: none, wherever seats were made. */
export const miscounted = (t: ReturnType<typeof convexTest>) =>
	t.run(async (ctx) => {
		const seats = new Map<string, number>();
		for (const row of await ctx.db.query("chatMembers").collect()) seats.set(row.chatId, (seats.get(row.chatId) ?? 0) + 1);
		return (await ctx.db.query("chats").collect())
			.filter((chat) => chat.memberCount !== (seats.get(chat._id) ?? 0))
			.map((chat) => ({ chat: chat.name ?? chat.kind, memberCount: chat.memberCount, seats: seats.get(chat._id) ?? 0 }));
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

/** Built-in role ids per transaction and workspace, so seeding thousands of members in one `t.run` reads the roles once. */
const builtInIds = new WeakMap<MutationCtx, Map<Id<"workspaces">, Record<"owner" | "member", Id<"roles">>>>();

/** One of a workspace's built-in roles, seeding Owner and Member first if it has no roles (a bare test workspace). */
export async function builtInRoleIn(ctx: MutationCtx, workspaceId: Id<"workspaces">, which: "owner" | "member") {
	const cache = builtInIds.get(ctx) ?? new Map();
	builtInIds.set(ctx, cache);
	let ids = cache.get(workspaceId);
	if (!ids) {
		if ((await rolesOf(ctx, workspaceId)).length === 0) await seedRoles(ctx, workspaceId);
		const roles = await rolesOf(ctx, workspaceId);
		ids = { owner: roles.find((r) => r.builtIn === "owner")!._id, member: roles.find((r) => r.builtIn === "member")!._id };
		cache.set(workspaceId, ids);
	}
	return ids[which];
}

/**
 * A membership row holding one built-in role, with the profile joining writes for someone with no preferences yet
 * (named by `email`). No reads but the cached roles, so thousands fit one transaction: pass the email they signed in with.
 */
export async function addMember(ctx: MutationCtx, { role, email = "", ...row }: { workspaceId: Id<"workspaces">; userId: Id<"users">; role: "owner" | "member"; email?: string }) {
	const normalized = email.trim().toLowerCase();
	return ctx.db.insert("members", { ...row, email: normalized, name: normalized || "Former member", timeZone: "UTC", roles: [await builtInRoleIn(ctx, row.workspaceId, role)] });
}

/** Turns one of the Member role's switches on or off, as an owner (roles.setPermission). */
export async function setMemberSwitch(owner: As, permission: Permission, on: boolean) {
	const member = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!;
	await owner.mutation(api.roles.setPermission, { id: member.id, permission, on });
}

/** Uploads a small file as `as` (the files.upload route), in their open workspace, and returns its storage id. */
export async function upload(as: As, body: Uint8Array = new TextEncoder().encode("notes"), name = "notes.txt") {
	const query = new URLSearchParams({ name, workspaceId: await workspaceOf(as) });
	const response = await as.fetch(`/files/upload?${query}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: body as Uint8Array<ArrayBuffer> });
	if (response.status !== 200) throw new Error(`Upload failed: ${response.status} ${await response.text()}`);
	return ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
}
