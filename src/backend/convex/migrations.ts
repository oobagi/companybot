import { type MigrationFunctionReference, Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

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

// Companybot got tools to make skills and automations from chat. New workspaces get them
// from default-agents.ts; this adds them to each existing Companybot that still has its
// default skills.load grant (so one an owner rebuilt on purpose is left alone). Saved as a
// new version, like an edit, so it shows in the agent's history.
export const companybotChatTools = migrations.define({
	table: "agents",
	migrateOne: async (ctx, agent) => {
		if (agent.name !== "Companybot" || !agent.tools.includes("skills.load")) return;
		const missing = ["skills.create", "automations.*"].filter((t) => !agent.tools.includes(t));
		if (missing.length === 0) return;
		const config = { name: agent.name, description: agent.description, instructions: agent.instructions, model: agent.model, tools: [...agent.tools, ...missing] };
		const version = agent.version + 1;
		await ctx.db.patch(agent._id, { tools: config.tools, version, updatedAt: Date.now() });
		await ctx.db.insert("agentVersions", { agentId: agent._id, version, config, savedBy: agent.updatedBy });
	},
});

/** Every migration, oldest first. Never reorder or remove entries that have shipped. */
const all: MigrationFunctionReference[] = [
	internal.migrations.connectorInstalls,
	internal.migrations.connectorConnections,
	internal.migrations.connectorOAuthFlows,
	internal.migrations.automationAudiences,
	internal.migrations.companybotChatTools,
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
