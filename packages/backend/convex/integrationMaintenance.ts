import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

export const sweep = internalMutation({ args: {}, handler: async ctx => {
	let more = false;
	for (const table of ["integrationOAuthClients", "integrationOAuthCodes", "integrationRefreshTokens", "integrationAudit", "integrationEvents"] as const) {
		const rows = await ctx.db.query(table).withIndex("by_expiry", q => q.lt("expiresAt", Date.now())).take(100);
		for (const row of rows) {
			if ("challenge" in row && !row.used && await ctx.db.get(row.tokenId)) await ctx.db.delete(row.tokenId);
			await ctx.db.delete(row._id);
		}
		more ||= rows.length === 100;
	}
	if (more) await ctx.scheduler.runAfter(0, internal.integrationMaintenance.sweep, {});
} });
