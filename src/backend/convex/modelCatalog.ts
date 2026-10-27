import { type ModelInfo, GATEWAY_MODELS_URL, fallbackModels, parseGatewayModels } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { type ActionCtx, type QueryCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { action } from "./functions";
import { modelInfo } from "./schema";

// The models agents can run on: AI Gateway's catalog, cached in one row since queries can't
// fetch. Refreshed daily (crons.ts) and when an agent editor opens on a day-old copy.
// Until the first fetch works, the fallback list stands in.

const STALE_MS = 24 * 60 * 60 * 1000;

/** The cached catalog, or the fallback list while it's empty. */
export async function catalogModels(ctx: QueryCtx): Promise<{ models: ModelInfo[]; fetchedAt: number | null }> {
	const row = await ctx.db.query("modelCatalog").first();
	return row && row.models.length > 0 ? { models: row.models, fetchedAt: row.fetchedAt } : { models: fallbackModels, fetchedAt: null };
}

/**
 * What a save may pick: the catalog, the fallback list, and the model the agent is on now, so an
 * agent whose model left the gateway still saves other edits.
 */
export async function allowedModels(ctx: QueryCtx, current?: string) {
	const { models } = await catalogModels(ctx);
	return [...models, ...fallbackModels, ...(current ? [{ id: current }] : [])];
}

async function fetchCatalog(ctx: ActionCtx) {
	const res = await fetch(GATEWAY_MODELS_URL);
	if (!res.ok) throw new Error(`AI Gateway models: HTTP ${res.status}`);
	const models = parseGatewayModels(await res.json());
	// An empty list is a broken response, not a gateway with no models: keep the old copy.
	if (models.length === 0) throw new Error("AI Gateway listed no models that can use tools.");
	await ctx.runMutation(internal.modelCatalog.save, { models });
}

export const refresh = internalAction({ args: {}, handler: (ctx) => fetchCatalog(ctx) });

/** Refreshes the catalog if it's a day old or was never fetched. The agent editor calls this as it opens. */
export const refreshIfStale = action({
	args: {},
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		if (!userId || !(await ctx.runQuery(internal.permissions.workspaceOf, { userId, workspaceId: ctx.workspaceId }))) return;
		const fetchedAt = await ctx.runQuery(internal.modelCatalog.fetchedAt, {});
		if (fetchedAt !== null && Date.now() - fetchedAt < STALE_MS) return;
		// The cached copy (or the fallback list) stays if the gateway can't be reached.
		await fetchCatalog(ctx).catch((e) => console.error(e));
	},
});

export const fetchedAt = internalQuery({
	args: {},
	handler: async (ctx) => (await ctx.db.query("modelCatalog").first())?.fetchedAt ?? null,
});

export const save = internalMutation({
	args: { models: v.array(modelInfo) },
	handler: async (ctx, { models }) => {
		const row = await ctx.db.query("modelCatalog").first();
		if (row) await ctx.db.replace(row._id, { models, fetchedAt: Date.now() });
		else await ctx.db.insert("modelCatalog", { models, fetchedAt: Date.now() });
	},
});
