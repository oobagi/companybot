import { type MigrationFunctionReference, Migrations } from "@convex-dev/migrations";
import { legacySkills, legacyAutomation } from "./legacyCatalogs";
import { startCascade } from "./cascade";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { trashEntry } from "./trashOps";

// Data migrations. Deploys never change stored rows; these do, once per deployment.
// `pnpm release` runs every pending one on prod right after deploying, and the
// component remembers which finished, so each runs once. See wiki/releases.md.
//
// Add one: define it below with `migrations.define`, keep it safe to re-run, and
// append it to `all`. Run on dev with `npx convex run migrations:runAll`.

export const migrations = new Migrations<DataModel>(components.migrations);

// Migrations that shipped in a release ran on prod then, and are deleted after: the component
// keys finished runs by name, so a retired one never runs again.

// Archiving agents became Delete (Trash): archived ones go to Trash as deleted now, by whoever last
// changed them, so they get the full 30 days. Small batches: even 1 MiB legacy documents fit.
export const trashAgents = migrations.define({
	table: "agents",
	batchSize: 8,
	migrateOne: async (ctx, agent) => {
		if (!agent.archived || (await trashEntry(ctx, agent._id))) return;
		await ctx.db.insert("trash", { workspaceId: agent.workspaceId, itemId: agent._id, deletedAt: Date.now(), kind: "agent", name: agent.name, deletedBy: agent.updatedBy });
	},
});

/** Snapshot live and trashed installs alike, without changing their Trash state or retention. */
export const storedSkills = migrations.define({
	table: "skillInstalls", batchSize: 8,
	migrateOne: async (ctx, install) => {
		const definition = legacySkills.find((s) => s.id === install.skillId);
		if (!install.custom && !install.definition && definition) await ctx.db.patch(install._id, { definition });
	},
});
export const storedAutomations = migrations.define({
	table: "automationInstalls", batchSize: 8,
	migrateOne: async (ctx, install) => {
		const definition = legacyAutomation(install.automationId);
		if (!install.custom && !install.definition && definition) await ctx.db.patch(install._id, { definition });
	},
});

// Apps that sent no workspace are gone (alpha.7), so their pins are too. Then the table can go.
export const clearLegacyWorkspaces = migrations.define({
	table: "legacyWorkspaces",
	migrateOne: async (ctx, pin) => ctx.db.delete(pin._id),
});

/** Retire the internal test connector. Access ends before its bounded credential/settings cleanup. */
export const retireNightOwl = migrations.define({
	table: "connectorInstalls", batchSize: 20,
	migrateOne: async (ctx, install) => {
		if (install.connectorId !== "night-owl") return;
		await ctx.db.delete(install._id);
		await startCascade(ctx, "connectorInstall", { workspaceId: install.workspaceId, connectorId: install.connectorId, connectorInstallId: install._id });
	},
});

/** Every retained migration, oldest first. Only retire shipped entries with their COMPAT cleanup. */
const all: MigrationFunctionReference[] = [
	internal.migrations.trashAgents,
	internal.migrations.storedSkills,
	internal.migrations.storedAutomations,
	internal.migrations.retireNightOwl,
	internal.migrations.clearLegacyWorkspaces,
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
