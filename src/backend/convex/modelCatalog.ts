import { type ImageModelInfo, type ModelInfo, GATEWAY_MODELS_URL, fallbackImageModels, fallbackModels, parseGatewayImageModels, parseGatewayModels } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { type ActionCtx, type QueryCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { action } from "./functions";
import { imageModelInfo, modelInfo } from "./schema";

// The models agents can run on, and the ones they make pictures with: AI Gateway's catalog, cached
// in one row since queries can't fetch. Refreshed daily (crons.ts) and when a model picker opens on
// a day-old copy. Until the first fetch works, the fallback lists stand in.

const STALE_MS = 24 * 60 * 60 * 1000;

/** The cached catalog, or the fallback list while it's empty. */
export async function catalogModels(ctx: QueryCtx): Promise<{ models: ModelInfo[]; fetchedAt: number | null }> {
	const row = await ctx.db.query("modelCatalog").first();
	return row && row.models.length > 0 ? { models: row.models, fetchedAt: row.fetchedAt } : { models: fallbackModels, fetchedAt: null };
}

/** The cached picture models, or the fallback list while there are none. */
export async function catalogImageModels(ctx: QueryCtx): Promise<ImageModelInfo[]> {
	const row = await ctx.db.query("modelCatalog").first();
	return row?.imageModels?.length ? row.imageModels : fallbackImageModels;
}

/** A picture model by id, from the catalog or the fallback list. */
export async function findImageModel(ctx: QueryCtx, id: string) {
	return [...(await catalogImageModels(ctx)), ...fallbackImageModels].find((m) => m.id === id);
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
	const body = await res.json();
	const models = parseGatewayModels(body);
	// An empty list is a broken response, not a gateway with no models: keep the old copy.
	if (models.length === 0) throw new Error("AI Gateway listed no models that can use tools.");
	await ctx.runMutation(internal.modelCatalog.save, { models, imageModels: parseGatewayImageModels(body) });
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
	args: { models: v.array(modelInfo), imageModels: v.optional(v.array(imageModelInfo)) },
	handler: async (ctx, { models, imageModels }) => {
		const row = await ctx.db.query("modelCatalog").first();
		// No picture models listed: keep the ones from before rather than none.
		const images = imageModels?.length ? imageModels : row?.imageModels;
		const next = { models, ...(images && { imageModels: images }), fetchedAt: Date.now() };
		if (row) await ctx.db.replace(row._id, next);
		else await ctx.db.insert("modelCatalog", next);
	},
});
