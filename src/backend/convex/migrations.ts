import { type MigrationFunctionReference, Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { defaultModel, usageMonth } from "@companybot/core";
import { recordUsage } from "./usage";

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

/** Every retained migration, oldest first. Only retire shipped entries with their COMPAT cleanup. */
const all: MigrationFunctionReference[] = [
	internal.migrations.lunaModel,
	internal.migrations.companybotHelpTool,
	internal.migrations.companybotWebTools,
	internal.migrations.usageThisMonth,
	internal.migrations.companybotImageTool,
	internal.migrations.clearTurnWelcome,
	internal.migrations.companybotFollowupTools,
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
