import { fromLegacy } from "./wakeups";
import { v } from "convex/values";
import { type MigrationFunctionReference, Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, internalQuery } from "./_generated/server";
import { TOPIC_MAX, defaultModel, scheduleCron, usageMonth, wakeAnchor } from "@companybot/core";
import { recordUsage } from "./usage";
import { type RunOutcome, scheduleCursor } from "./automationOps";
import { memberProfile, rolesOf, timeZoneOf } from "./lib";
import { seedRoles } from "./roles";
import { withoutPageTitles } from "./pageBlocks";

// Data migrations. Deploys never change stored rows; these do, once per deployment.
// `pnpm release` runs every pending one on prod right after deploying, and the
// component remembers which finished, so each runs once. See wiki/releases.md.
//
// Add one: define it below with `migrations.define`, keep it safe to re-run, and
// append it to `all`. Run on dev with `npx convex run migrations:runAll`.

export const migrations = new Migrations<DataModel>(components.migrations);

// Migrations that shipped in a release ran on prod then, and are deleted after: the component
// keys finished runs by name, so a retired one never runs again.

// The default model moved from Claude Sonnet 5.5 to GPT-6 Luna (about 20x cheaper). Agents still
// on the old default move with it; any other model was picked on purpose and stays.
export const lunaModel = migrations.define({
	table: "agents",
	batchSize: 8,
	migrateOne: async (ctx, agent) => {
		if (agent.model === "anthropic/claude-sonnet-5.5") await ctx.db.patch(agent._id, { model: defaultModel });
	},
});

// Companybot got help.read, to answer how-do-I and where-is questions. New workspaces get it from
// default-agents.ts; this adds it to each existing Companybot that still has its default skills.load
// grant (one an owner rebuilt on purpose is left alone), saved as a new version like an edit.
export const companybotHelpTool = migrations.define({
	table: "agents",
	batchSize: 8,
	migrateOne: async (ctx, agent) => {
		if (agent.name !== "Companybot" || !agent.tools.includes("skills.load") || agent.tools.includes("help.read")) return;
		const config = { name: agent.name, description: agent.description, instructions: agent.instructions, model: agent.model, tools: [...agent.tools, "help.read"] };
		const version = agent.version + 1;
		await ctx.db.patch(agent._id, { tools: config.tools, version, updatedAt: Date.now() });
		await ctx.db.insert("agentVersions", { agentId: agent._id, version, config, savedBy: agent.updatedBy });
	},
});

// Companybot got web search and pages. New workspaces get them from default-agents.ts; this adds
// them to each existing Companybot that still has its default skills.load grant (one an owner
// rebuilt on purpose is left alone). Saved as a new version, like an edit, so it shows in history.
export const companybotWebTools = migrations.define({
	table: "agents",
	batchSize: 8,
	migrateOne: async (ctx, agent) => {
		if (agent.name !== "Companybot" || !agent.tools.includes("skills.load") || agent.tools.includes("web.*")) return;
		const config = { name: agent.name, description: agent.description, instructions: agent.instructions, model: agent.model, tools: [...agent.tools, "web.*"] };
		const version = agent.version + 1;
		await ctx.db.patch(agent._id, { tools: config.tools, version, updatedAt: Date.now() });
		await ctx.db.insert("agentVersions", { agentId: agent._id, version, config, savedBy: agent.updatedBy });
	},
});

// Companybot got images.generate, to make and edit pictures. New workspaces get it from
// default-agents.ts; this adds it to each existing Companybot that still has its default skills.load
// grant (one an owner rebuilt on purpose is left alone), saved as a new version like an edit.
export const companybotImageTool = migrations.define({
	table: "agents",
	batchSize: 8,
	migrateOne: async (ctx, agent) => {
		if (agent.name !== "Companybot" || !agent.tools.includes("skills.load") || agent.tools.includes("images.generate") || agent.tools.includes("images.*")) return;
		const config = { name: agent.name, description: agent.description, instructions: agent.instructions, model: agent.model, tools: [...agent.tools, "images.generate"] };
		const version = agent.version + 1;
		await ctx.db.patch(agent._id, { tools: config.tools, version, updatedAt: Date.now() });
		await ctx.db.insert("agentVersions", { agentId: agent._id, version, config, savedBy: agent.updatedBy });
	},
});

// The Usage screen reads the `usage` table, which replies only fill from now on: add this month's earlier
// replies (summaries before it weren't kept apart from replies, so they're missed). `counted` marks each reply
// as in the table, so ones recorded live meanwhile, or a second run, can't be added twice.
export const usageThisMonth = migrations.define({
	table: "agentTurns",
	batchSize: 20,
	migrateOne: async (ctx, turn) => {
		const thisMonth = usageMonth(Date.now());
		if (usageMonth(turn._creationTime) !== thisMonth || !turn.replyId) return;
		const reply = await ctx.db.get(turn.replyId);
		const stats = reply?.stats;
		if (!reply || !stats || stats.counted) return;
		const counted = await recordUsage(ctx, { workspaceId: turn.workspaceId, userId: turn.actorId, agentId: turn.agentId, kind: "chat", model: stats.model, costUsd: stats.costUsd });
		if (counted) await ctx.db.patch(reply._id, { stats: { ...stats, counted } });
	},
});

// Welcomes became fixed text (onboarding.ts), but old turns still carry their retired `welcome`. Clearing it
// lets the schema drop the field.
export const clearTurnWelcome = migrations.define({
	table: "agentTurns",
	batchSize: 20,
	migrateOne: async (ctx, turn) => {
		if (turn.welcome) await ctx.db.patch(turn._id, { welcome: undefined });
	},
});

// Companybot got follow-ups, so it can check back later (wakeups.ts). New workspaces get them from
// default-agents.ts; this adds them to each existing Companybot that still has its default skills.load
// grant (one an owner rebuilt on purpose is left alone), saved as a new version like an edit.
export const companybotFollowupTools = migrations.define({
	table: "agents",
	batchSize: 8,
	migrateOne: async (ctx, agent) => {
		if (agent.name !== "Companybot" || !agent.tools.includes("skills.load") || agent.tools.includes("followups.*")) return;
		const config = { name: agent.name, description: agent.description, instructions: agent.instructions, model: agent.model, tools: [...agent.tools, "followups.*"] };
		const version = agent.version + 1;
		await ctx.db.patch(agent._id, { tools: config.tools, version, updatedAt: Date.now() });
		await ctx.db.insert("agentVersions", { agentId: agent._id, version, config, savedBy: agent.updatedBy });
	},
});

// Schedules became cron (core schedules.ts). This writes each stored "one time on some weekdays"
// schedule (made ones and retained library definitions) as its cron, unchanged in meaning and not a
// new version, and starts its runs after its last one, so nothing runs twice or makes up a run.
export const cronSchedules = migrations.define({
	table: "automationInstalls",
	batchSize: 20,
	migrateOne: async (ctx, install) => {
		const { custom, definition } = install;
		const patch: Partial<typeof install> = {};
		if (custom?.trigger.type === "schedule" && "time" in custom.trigger) patch.custom = { ...custom, trigger: { type: "schedule", cron: scheduleCron(custom.trigger) } };
		if (definition?.trigger.type === "schedule" && "time" in definition.trigger)
			patch.definition = { ...definition, trigger: { type: "schedule", cron: scheduleCron(definition.trigger) } };
		if ((custom ?? definition)?.trigger.type === "schedule" && install.lastScheduledAt === undefined) patch.lastScheduledAt = scheduleCursor(install);
		if (install.lastRunDate !== undefined) patch.lastRunDate = undefined;
		if (Object.keys(patch).length > 0) await ctx.db.patch(install._id, patch);
	},
});

// Roles became workspace data (roles.ts): each workspace gets Owner and Member, and every person,
// invite and connector moves from "owner"/"member" to those roles' ids. Run in this order (`all`), so
// each workspace has its roles before its people move. Rows the app made since already have them.
// COMPAT(0.1.0-alpha.10): once these have run on prod, delete them and their test, and the legacy fields (schema.ts).
export const customRoles = migrations.define({
	table: "workspaces",
	batchSize: 20,
	migrateOne: async (ctx, workspace) => {
		if ((await rolesOf(ctx, workspace._id)).length === 0) await seedRoles(ctx, workspace._id);
	},
});

/** The workspace's role for a retired "owner" or "member", or none if the workspace is gone. */
async function legacyRoleId(ctx: MutationCtx, workspaceId: Id<"workspaces">, role: "owner" | "member") {
	return (await rolesOf(ctx, workspaceId)).find((r) => r.builtIn === role)?._id;
}

const moveRole = async (ctx: MutationCtx, row: Doc<"members"> | Doc<"invites">) => {
	if (row.role === undefined) return;
	const id = row.roles ? undefined : await legacyRoleId(ctx, row.workspaceId, row.role);
	await ctx.db.patch(row._id, { role: undefined, ...(!row.roles && { roles: id ? [id] : [] }) });
};

export const customRolesMembers = migrations.define({ table: "members", batchSize: 50, migrateOne: moveRole });
export const customRolesInvites = migrations.define({ table: "invites", batchSize: 50, migrateOne: moveRole });

export const customRolesConnectors = migrations.define({
	table: "connectorInstalls",
	batchSize: 50,
	migrateOne: async (ctx, install) => {
		if (!install.roles.some((r) => r === "owner" || r === "member")) return;
		// Owners can use every connector now, so "owner" needs no role.
		const member = install.roles.includes("member") ? await legacyRoleId(ctx, install.workspaceId, "member") : undefined;
		const kept = install.roles.filter((r) => r !== "owner" && r !== "member");
		await ctx.db.patch(install._id, { roles: [...new Set([...kept, ...(member ? [member] : [])])] });
	},
});

// Page move history held the titles of the places a page moved between, which named pages some people
// can't see (Who can access). Rows now hold ids, named to each reader by what they can see (pages.moves).
// "Pages" is the top level; any other title becomes the one standalone page in the workspace with exactly
// that title, or stays unknown ("another page") when none or several match.
// COMPAT(0.1.0-alpha.10): once this has run on prod, delete it, its entry in `all` and its test, and the legacy fields (schema.ts).
export const pageMoveIds = migrations.define({
	table: "pageMoves",
	batchSize: 20,
	migrateOne: async (ctx, row) => {
		if (row.from === undefined && row.to === undefined) return;
		const idOf = async (title: string | undefined) => {
			if (title === undefined || title === "Pages") return title === undefined ? undefined : null;
			// Exact title, live or archived, by index: the second match settles it as ambiguous.
			const exact: Id<"pages">[] = [];
			for (const archived of [false, true]) {
				const found = await ctx.db
					.query("pages")
					.withIndex("by_workspace", (q) => q.eq("workspaceId", row.workspaceId).eq("recordId", undefined).eq("archived", archived).eq("title", title))
					.take(2 - exact.length);
				exact.push(...found.map((p) => p._id));
				if (exact.length > 1) return undefined;
			}
			return exact[0];
		};
		await ctx.db.patch(row._id, { fromId: await idOf(row.from), toId: await idOf(row.to), from: undefined, to: undefined });
	},
});

// Page blocks held their sub-page's title, so a page's history (and its sync) named sub-pages some
// readers can't see. Blocks hold only the id now (pageBlocks.ts); this strips the titles from every kept
// version's snapshot. Old steps keep theirs, but every read strips them on the way out (pageSync.ts).
// COMPAT(0.1.0-alpha.10): once this has run on prod, delete it, its entry in `all` and its test.
export const pageBlockTitles = migrations.define({
	table: "pageVersions",
	batchSize: 10,
	migrateOne: async (ctx, row) => {
		const { getSnapshot, deleteSnapshots, submitSnapshot } = components.prosemirrorSync.lib;
		const snapshot = await ctx.runQuery(getSnapshot, { id: row.pageId, version: row.version });
		if (snapshot.content === null || snapshot.version !== row.version) return;
		const content = withoutPageTitles(snapshot.content);
		if (content === snapshot.content) return;
		// The component never overwrites a version's snapshot with different content, so replace it.
		await ctx.runMutation(deleteSnapshots, { id: row.pageId, afterVersion: row.version - 1, beforeVersion: row.version + 1 });
		await ctx.runMutation(submitSnapshot, { id: row.pageId, version: row.version, content });
	},
});

// An automation's last run was stored as its line, naming channels to everyone who could see the automation,
// some of whom can't see those channels. Runs store the channel's id now (automationOps.RunOutcome); this
// turns each old line into that, finding the channel it names, or drops the line when it can't.
// COMPAT(0.1.0-alpha.10): once this has run on prod, delete it, its entry in `all` and its test, and `lastResult` (schema.ts).
export const automationOutcomes = migrations.define({
	table: "automationInstalls",
	batchSize: 50,
	migrateOne: async (ctx, install) => {
		const line = install.lastResult;
		if (line === undefined) return;
		const channel = async (name: string) => {
			const found = [];
			for (const archived of [false, true])
				found.push(...(await ctx.db.query("chats").withIndex("by_name", (q) => q.eq("workspaceId", install.workspaceId).eq("name", name).eq("archived", archived)).take(2)));
			return found.length === 1 && found[0]!.kind === "channel" ? found[0]!._id : undefined;
		};
		const trigger = install.custom?.trigger;
		const watched = trigger?.type === "event" && trigger.event === "message.posted" ? ctx.db.normalizeId("chats", trigger.channelId) : null;
		const posted = /^Posted in #(.+)\.$/.exec(line);
		const missing = /^(Didn't run: .+) in #(.+)\. Pick another channel\.$/.exec(line);
		const watches = /^(Didn't run: It watches )#.+?(, which .+)$/.exec(line);
		let outcome: RunOutcome | undefined;
		if (!line.includes("#")) outcome = { text: line };
		else if (posted) {
			const channelId = await channel(posted[1]!);
			if (channelId) outcome = { text: "Posted in {channel}.", channelId };
		} else if (missing) {
			const channelId = await channel(missing[2]!);
			if (channelId) outcome = { text: `${missing[1]} in {channel}. Pick another channel.`, channelId };
		} else if (watches && watched) outcome = { text: `${watches[1]}{watched}${watches[2]}`, watchedId: watched };
		await ctx.db.patch(install._id, { lastResult: undefined, ...(outcome && { lastOutcome: outcome }) });
	},
});

// COMPAT(0.1.0-alpha.10): once this has run on prod, delete it and its test, and make audience required.
export const skillAudience = migrations.define({
	table: "skillInstalls",
	migrateOne: async (ctx, row) => { if (!row.audience) await ctx.db.patch(row._id, { audience: "team" }); },
});

// COMPAT(0.1.0-alpha.10): retire after numeric wakeup intervals have been converted.
export const wakeupDurations = migrations.define({
	table: "wakeups",
	migrateOne: async (ctx, row) => {
		if (row.every === undefined) return;
		return { repeat: row.repeat ?? fromLegacy(row.every), anchor: row.anchor ?? (row.at === undefined ? undefined : wakeAnchor(row.at, await timeZoneOf(ctx, row.actorId))), every: undefined };
	},
});

// COMPAT(0.1.0-alpha.10): cuts topics from before the 250-character cap (core TOPIC_MAX) so the
// sidebar's channel read stays small. Once this has run on prod, delete it, its entry in `all` and its test.
export const channelTopics = migrations.define({
	table: "chats",
	migrateOne: async (ctx, row) => {
		if (row.topic && row.topic.length > TOPIC_MAX) await ctx.db.patch(row._id, { topic: row.topic.slice(0, TOPIC_MAX) });
	},
});

// chat_react is gone: an agent reacts only through its turn's decision (core postDecision). These strip
// its grant from agents and their saved versions (a save or a restore would refuse the unknown tool) and
// drop any rule or lock on it. Not a new version: nothing the agent can do changes.
const CHAT_REACT = "chat.react";
export const dropChatReact = migrations.define({
	table: "agents",
	batchSize: 20,
	migrateOne: async (ctx, agent) => {
		if (agent.tools.includes(CHAT_REACT)) await ctx.db.patch(agent._id, { tools: agent.tools.filter((t) => t !== CHAT_REACT) });
	},
});
export const dropChatReactVersions = migrations.define({
	table: "agentVersions",
	batchSize: 20,
	migrateOne: async (ctx, { _id, config }) => {
		if (config.tools.includes(CHAT_REACT)) await ctx.db.patch(_id, { config: { ...config, tools: config.tools.filter((t) => t !== CHAT_REACT) } });
	},
});
export const dropChatReactRules = migrations.define({
	table: "permissionRules",
	batchSize: 50,
	migrateOne: async (ctx, rule) => {
		if (rule.action === CHAT_REACT) await ctx.db.delete(rule._id);
	},
});
export const dropChatReactLocks = migrations.define({
	table: "permissionLocks",
	batchSize: 50,
	migrateOne: async (ctx, lock) => {
		if (lock.action === CHAT_REACT) await ctx.db.delete(lock._id);
	},
});

// A chat's last message time and running cost moved to its own `chatActivity` row, so a message no longer
// re-runs every query that reads the chat. This moves each chat's onto that row (one the app made since
// already started from the chat's, so it's newer and stays) and clears them from the chat.
// COMPAT(0.1.0-alpha.10): once this has run on prod, delete it, its entry in `all` and its test, the two
// legacy fields (schema.ts) and the fallback in chatOps `activityOf`.
export const chatActivity = migrations.define({
	table: "chats",
	batchSize: 50,
	migrateOne: async (ctx, chat) => {
		if (chat.lastMessageAt === undefined && chat.costUsd === undefined) return;
		const row = await ctx.db.query("chatActivity").withIndex("by_chat", (q) => q.eq("chatId", chat._id)).unique();
		if (!row) await ctx.db.insert("chatActivity", { chatId: chat._id, lastMessageAt: chat.lastMessageAt ?? chat._creationTime, ...(chat.costUsd ? { costUsd: chat.costUsd } : {}) });
		await ctx.db.patch(chat._id, { lastMessageAt: undefined, costUsd: undefined });
	},
});

// Lists page by when each message was shown (`publishedAt`, index by_chat_shown), so a reply shown late is on the
// newest page. New messages get it when sent or shown; this gives older ones theirs: where they sit now (shownAt).
// COMPAT(0.1.0-alpha.10): once this has run on prod, delete it, its entry in `all` and its test.
export const messageShownAt = migrations.define({
	table: "chatMessages",
	batchSize: 100,
	migrateOne: async (ctx, m) => {
		if (m.publishedAt === undefined && !m.quiet) await ctx.db.patch(m._id, { publishedAt: m._creationTime });
	},
});

// COMPAT(0.1.0-alpha.10): member lists read only `members` (workspace.team), so each row copies its person's
// profile. Once these have run on prod, delete them, their entries in `all` and their test, make
// `members.name`, `members.timeZone` and `chats.memberCount` required, and drop `preferences.workspaceId` (schema.ts).
export const memberProfiles = migrations.define({
	table: "members",
	batchSize: 50,
	migrateOne: async (ctx, row) => {
		const profile = await memberProfile(ctx, row.userId);
		if (row.name !== profile.name || row.image !== profile.image || row.timeZone !== profile.timeZone) await ctx.db.patch(row._id, profile);
	},
});

// The last used workspace moved out of `preferences`, so switching touches nothing member lists read.
// One saved since (`lastWorkspaces`) is newer and stays.
export const lastWorkspaces = migrations.define({
	table: "preferences",
	batchSize: 50,
	migrateOne: async (ctx, row) => {
		if (row.workspaceId === undefined) return;
		const saved = await ctx.db.query("lastWorkspaces").withIndex("by_user", (q) => q.eq("userId", row.userId)).first();
		if (!saved && (await ctx.db.get(row.workspaceId))) await ctx.db.insert("lastWorkspaces", { userId: row.userId, workspaceId: row.workspaceId });
		await ctx.db.patch(row._id, { workspaceId: undefined });
	},
});

// Each chat counts its seats, so channel browsing doesn't read them. Chats made since start at 0 and count live.
// A big chat is counted SEAT_COUNT_STEP seats a transaction, oldest first, its progress on the chat (`seatCount`):
// seats added meanwhile are newer, so a later step reads them; one removed that was already counted comes off
// (chatOps.countSeats).
const SEAT_COUNT_STEP = 4_000;
export const chatMemberCounts = migrations.define({
	table: "chats",
	batchSize: 1,
	migrateOne: async (ctx, chat) => {
		if (!(await countSeatsStep(ctx, chat._id))) await ctx.scheduler.runAfter(0, internal.migrations.continueSeatCount, { chatId: chat._id });
	},
});

/** Counts the next seats of a chat still being counted. True once it has its `memberCount`. */
async function countSeatsStep(ctx: MutationCtx, chatId: Id<"chats">) {
	const chat = await ctx.db.get(chatId);
	if (!chat || chat.memberCount !== undefined) return true;
	const { counted, after } = chat.seatCount ?? { counted: 0, after: 0 };
	const seats = await ctx.db.query("chatMembers").withIndex("by_chat", (q) => q.eq("chatId", chatId).gt("_creationTime", after)).take(SEAT_COUNT_STEP);
	if (seats.length < SEAT_COUNT_STEP) {
		await ctx.db.patch(chatId, { memberCount: counted + seats.length, seatCount: undefined });
		return true;
	}
	await ctx.db.patch(chatId, { seatCount: { counted: counted + seats.length, after: seats.at(-1)!._creationTime } });
	return false;
}

export const continueSeatCount = internalMutation({
	args: { chatId: v.id("chats") },
	handler: async (ctx, { chatId }) => {
		if (!(await countSeatsStep(ctx, chatId))) await ctx.scheduler.runAfter(0, internal.migrations.continueSeatCount, { chatId });
	},
});

/** Every retained migration, oldest first. Only retire shipped entries with their COMPAT cleanup. */
const all: MigrationFunctionReference[] = [
	internal.migrations.lunaModel,
	internal.migrations.companybotHelpTool,
	internal.migrations.companybotWebTools,
	internal.migrations.usageThisMonth,
	internal.migrations.companybotImageTool,
	internal.migrations.clearTurnWelcome,
	internal.migrations.companybotFollowupTools,
	internal.migrations.cronSchedules,
	internal.migrations.customRoles,
	internal.migrations.customRolesMembers,
	internal.migrations.customRolesInvites,
	internal.migrations.customRolesConnectors,
	// COMPAT(0.1.0-alpha.10): retire these with their migrations above.
	internal.migrations.pageMoveIds,
	internal.migrations.pageBlockTitles,
	internal.migrations.automationOutcomes,
	internal.migrations.skillAudience,
	internal.migrations.wakeupDurations,
	internal.migrations.dropChatReact,
	internal.migrations.dropChatReactVersions,
	internal.migrations.dropChatReactRules,
	internal.migrations.dropChatReactLocks,
	internal.migrations.channelTopics,
	internal.migrations.chatActivity,
	internal.migrations.messageShownAt,
	internal.migrations.memberProfiles,
	internal.migrations.lastWorkspaces,
	internal.migrations.chatMemberCounts,
];

/** Starts every pending migration, in order. Finished ones are skipped. */
export const runAll = internalMutation({
	args: {},
	handler: async (ctx) => migrations.runSerially(ctx, all),
});

/** Whether any migration is still running or failed, for the release script to wait on. */
export const status = internalQuery({
	args: {},
	handler: async (ctx) => {
		const statuses = await migrations.getStatus(ctx, { migrations: all });
		return statuses.map((s) => ({ name: s.name, state: s.state, error: s.error }));
	},
});
