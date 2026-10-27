import { type MigrationFunctionReference, Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { addUserMentions } from "./chatOps";
import { pinLegacyWorkspace } from "./lib";
import { seedRecordTypes } from "./recordOps";
import { saveVersion } from "./agents";

// Data migrations. Deploys never change stored rows; these do, once per deployment.
// `pnpm release` runs every pending one on prod right after deploying, and the
// component remembers which finished, so each runs once. See wiki/releases.md.
//
// Add one: define it below with `migrations.define`, keep it safe to re-run, and
// append it to `all`. Run on dev with `npx convex run migrations:runAll`.

export const migrations = new Migrations<DataModel>(components.migrations);

// "Plugins" became "connectors": move each row to its renamed table. Copy-then-delete,
// so a re-run finds nothing left to move.
export const connectorInstalls = migrations.define({
	table: "pluginInstalls",
	migrateOne: async (ctx, { _id, _creationTime, pluginId, ...rest }) => {
		await ctx.db.insert("connectorInstalls", { ...rest, connectorId: pluginId });
		await ctx.db.delete(_id);
	},
});

export const connectorConnections = migrations.define({
	table: "pluginConnections",
	migrateOne: async (ctx, { _id, _creationTime, pluginId, ...rest }) => {
		await ctx.db.insert("connectorConnections", { ...rest, connectorId: pluginId });
		await ctx.db.delete(_id);
	},
});

export const connectorOAuthFlows = migrations.define({
	table: "pluginOAuthFlows",
	migrateOne: async (ctx, { _id, _creationTime, pluginId, ...rest }) => {
		await ctx.db.insert("connectorOAuthFlows", { ...rest, connectorId: pluginId });
		await ctx.db.delete(_id);
	},
});

// Automations got audiences: installs from before ran for everyone (or a channel). Keep
// channels; the rest now run for people who turn them on, starting with whoever set it up.
export const automationAudiences = migrations.define({
	table: "automationInstalls",
	migrateOne: async (ctx, install) => {
		if (install.audience) return;
		const audience = install.channelId ? "channel" : "subscribers";
		await ctx.db.patch(install._id, { audience });
		if (audience === "subscribers")
			await ctx.db.insert("automationSubscriptions", { installId: install._id, userId: install.installedBy });
	},
});

/** Adds `tools` to each Companybot that still has its default skills.load grant, saved as a new version. */
function grantCompanybot(tools: string[]) {
	return migrations.define({
		table: "agents",
		migrateOne: async (ctx, agent) => {
			if (agent.name !== "Companybot" || !agent.tools.includes("skills.load")) return;
			const missing = tools.filter((t) => !agent.tools.includes(t));
			if (missing.length === 0) return;
			const config = { name: agent.name, description: agent.description, instructions: agent.instructions, model: agent.model, tools: [...agent.tools, ...missing] };
			await saveVersion(ctx, agent, config, agent.updatedBy);
		},
	});
}

// Companybot got tools to make skills and automations from chat. New workspaces get them
// from default-agents.ts; this adds them to each existing Companybot that still has its
// default skills.load grant (so one an owner rebuilt on purpose is left alone). Saved as a
// new version, like an edit, so it shows in the agent's history.
export const companybotChatTools = grantCompanybot(["skills.create", "automations.*"]);

// Records arrived: give workspaces from before them the built-in types (clients, deals,
// tasks, calls). New workspaces get them in workspace.ensure. Seeding skips types that exist.
export const recordTypes = migrations.define({
	table: "workspaces",
	migrateOne: async (ctx, workspace) => {
		const owner = await ctx.db
			.query("members")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
			.filter((q) => q.eq(q.field("role"), "owner"))
			.first();
		if (owner) await seedRecordTypes(ctx, workspace._id, owner.userId);
	},
});

// Companybot got records tools (the CRM from chat). Same rule as companybotChatTools: only
// Companybots that still have their default skills.load grant, saved as a new version.
export const companybotRecordTools = grantCompanybot(["records.*"]);

// Companybot got pages tools (wiki/pages.md). Same rule.
export const companybotPageTools = grantCompanybot(["pages.*"]);

// Apps that send no workspace act in a pinned one (lib.ts legacyMemberOf): pin everyone's first.
export const legacyWorkspaces = migrations.define({
	table: "members",
	migrateOne: async (ctx, member) => pinLegacyWorkspace(ctx, member.userId),
});

// Unread mentions moved to an index (userMentions): add rows for messages sent before it.
// Small batches, and a message mentioning many people adds its rows MENTIONS_PER_WRITE at a
// time in its own mutations, so no transaction nears the write limit however many it names.
const MENTIONS_PER_WRITE = 100;

export const userMentions = migrations.define({
	table: "chatMessages",
	batchSize: 20,
	migrateOne: async (ctx, message) => {
		if (message.mentions.userIds.length === 0) return;
		if (message.mentions.userIds.length <= MENTIONS_PER_WRITE) await addUserMentions(ctx, message);
		else await ctx.scheduler.runAfter(0, internal.migrations.userMentionsFrom, { messageId: message._id, from: 0 });
	},
});

/** Adds one slice of a message's mention rows, then schedules the next. */
export const userMentionsFrom = internalMutation({
	args: { messageId: v.id("chatMessages"), from: v.number() },
	handler: async (ctx, { messageId, from }) => {
		const message = await ctx.db.get(messageId);
		if (!message) return;
		const to = from + MENTIONS_PER_WRITE;
		await addUserMentions(ctx, message, { from, to });
		if (to < message.mentions.userIds.length) await ctx.scheduler.runAfter(0, internal.migrations.userMentionsFrom, { messageId, from: to });
	},
});

/** Every migration, oldest first. Never reorder or remove entries that have shipped. */
const all: MigrationFunctionReference[] = [
	internal.migrations.connectorInstalls,
	internal.migrations.connectorConnections,
	internal.migrations.connectorOAuthFlows,
	internal.migrations.automationAudiences,
	internal.migrations.companybotChatTools,
	internal.migrations.recordTypes,
	internal.migrations.companybotRecordTools,
	internal.migrations.companybotPageTools,
	internal.migrations.legacyWorkspaces,
	internal.migrations.userMentions,
];

/** Starts every pending migration, in order. Finished ones are skipped. */
export const runAll = internalMutation({
	args: {},
	handler: async (ctx) => (all.length > 0 ? await migrations.runSerially(ctx, all) : null),
});

/** Whether any migration is still running or failed, for the release script to wait on. */
export const status = internalQuery({
	args: {},
	handler: async (ctx) => {
		const statuses = all.length > 0 ? await migrations.getStatus(ctx, { migrations: all }) : [];
		return statuses.map((s) => ({ name: s.name, state: s.state, error: s.error }));
	},
});
