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

/** Every migration, oldest first. Never reorder or remove entries that have shipped. */
const all: MigrationFunctionReference[] = [
	internal.migrations.connectorInstalls,
	internal.migrations.connectorConnections,
	internal.migrations.connectorOAuthFlows,
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
