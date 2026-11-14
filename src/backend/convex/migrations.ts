import { rankAt } from "@companybot/core/rank";
import { NAME_KEY } from "@companybot/core/records";
import { VIEWS_MAX } from "./databaseViews";
import { checkWidths, fieldsOf, groupsCards } from "./recordOps";
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

// Drive got files (driveFiles.ts) and Companybot the tools for them. New workspaces get them from
// default-agents.ts; this adds them to each existing Companybot that still has its default skills.load
// grant (one an owner rebuilt on purpose is left alone), saved as a new version like an edit.
export const companybotFileTools = migrations.define({
	table: "agents",
	batchSize: 8,
	migrateOne: async (ctx, agent) => {
		if (agent.name !== "Companybot" || !agent.tools.includes("skills.load") || agent.tools.includes("files.*")) return;
		const config = { name: agent.name, description: agent.description, instructions: agent.instructions, model: agent.model, tools: [...agent.tools, "files.*"] };
		const version = agent.version + 1;
		await ctx.db.patch(agent._id, { tools: config.tools, version, updatedAt: Date.now() });
		await ctx.db.insert("agentVersions", { agentId: agent._id, version, config, savedBy: agent.updatedBy });
	},
});

// Customize left the rail for workspace settings: saved rail orders drop its id.
export const railDropCustomize = migrations.define({
	table: "arrangements",
	batchSize: 100,
	migrateOne: async (ctx, row) => {
		if (row.list === "rail" && row.ids.includes("customize")) await ctx.db.patch(row._id, { ids: row.ids.filter((id) => id !== "customize") });
	},
});

// Boards keep a manual order (records.rank): records start in it by creation time, newest first, as they listed.
export const recordRanks = migrations.define({
	table: "records",
	batchSize: 100,
	migrateOne: async (ctx, record) => {
		if (record.rank === undefined) await ctx.db.patch(record._id, { rank: rankAt(record._creationTime, record._id) });
	},
});

// Views no longer carry a note about filters a field change removed: clear the old ones.
export const dropViewNotice = migrations.define({
	table: "databaseViews",
	batchSize: 100,
	migrateOne: async (ctx, view) => {
		if (view.notice !== undefined) await ctx.db.patch(view._id, { notice: undefined });
	},
});

// The All tab became an ordinary saved view. Each database gets a view named "All" with what its All tab showed
// everyone: its shared columns (the `columns` arrangement, or without one Name and the next four live fields, as
// the app did) and its `display` (layout, grouping, column widths). It goes first in the database's view order, so
// it's still what opens, and then `display` and the columns arrangement go.
// - A saved view already named "All" keeps its name; the new one is "All 2" (or "All 3", and so on).
// - Done already: no `display`, no columns arrangement, and the first view in order is one of those names. That's
//   a re-run, or a database made since (recordOps.createType makes its own All), and it's left alone.
// - A database already at VIEWS_MAX views gets no new one, since nobody could see a view past the limit: it
//   opens on its first view. Its old All settings are cleared all the same.
// COMPAT(0.1.0-alpha.11): once this has run on prod, delete it, its entry in `all` and its test, `recordTypes.display`
// (schema.ts), the `setDisplay` and `migrateDisplay` stubs (recordTypes.ts) and the `columns` arrangement list.
export const allView = migrations.define({
	table: "recordTypes",
	batchSize: 20,
	migrateOne: async (ctx, type) => {
		const arrangement = (list: "views" | "columns") =>
			ctx.db.query("arrangements").withIndex("by_list", (q) => q.eq("workspaceId", type.workspaceId).eq("userId", undefined).eq("list", list).eq("entityId", type._id)).unique();
		const order = await arrangement("views");
		const shared = await arrangement("columns");
		const views = await ctx.db.query("databaseViews").withIndex("by_type", (q) => q.eq("typeId", type._id)).take(VIEWS_MAX);
		const first = order?.ids.map((id) => views.find((v) => v._id === id)).find((v) => v) ?? views[0];
		if (!type.display && !shared && first && /^All( \d+)?$/.test(first.name)) return;
		if (views.length < VIEWS_MAX) {
			const fields = (await fieldsOf(ctx, type._id)).filter((f) => !f.archived);
			const live = fields.map((f) => f.key);
			const kept = [...new Set(shared?.ids.filter((key) => live.includes(key)))];
			const columns = !kept.length ? live.slice(0, 5) : kept.includes(NAME_KEY) ? kept : [NAME_KEY, ...kept];
			const { layout, groupBy, widths } = type.display ?? {};
			let name = "All";
			for (let n = 2; views.some((v) => v.name.toLowerCase() === name.toLowerCase()); n++) name = `All ${n}`;
			const id = await ctx.db.insert("databaseViews", {
				workspaceId: type.workspaceId,
				typeId: type._id,
				name,
				filters: [],
				columns,
				// Only what a saved view would accept: a board needs a field to group by.
				...(layout === "board" && fields.some(groupsCards) && { layout }),
				...(groupBy && fields.some((f) => f.key === groupBy && groupsCards(f)) && { groupBy }),
				widths: checkWidths(widths, columns),
				version: 1,
			});
			if (order) await ctx.db.patch(order._id, { ids: [id, ...order.ids] });
			else await ctx.db.insert("arrangements", { workspaceId: type.workspaceId, list: "views", entityId: type._id, ids: [id] });
		}
		if (shared) await ctx.db.delete(shared._id);
		if (type.display) await ctx.db.patch(type._id, { display: undefined });
	},
});

/** Every retained migration, oldest first. Only retire shipped entries with their COMPAT cleanup. */
const all: MigrationFunctionReference[] = [
	internal.migrations.companybotFileTools,
	internal.migrations.railDropCustomize,
	internal.migrations.dropViewNotice,
	internal.migrations.recordRanks,
	internal.migrations.allView,
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
