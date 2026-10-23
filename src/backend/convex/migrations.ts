import { type MigrationFunctionReference, Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";

// Data migrations. Deploys never change stored rows; these do, once per deployment.
// `pnpm release` runs every pending one on prod right after deploying, and the
// component remembers which finished, so each runs once. See wiki/releases.md.
//
// Add one: define it below with `migrations.define`, keep it safe to re-run, and
// append it to `all`. Run on dev with `npx convex run migrations:runAll`.

export const migrations = new Migrations<DataModel>(components.migrations);

/** Every migration, oldest first. Never reorder or remove entries that have shipped. */
const all: MigrationFunctionReference[] = [];

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
