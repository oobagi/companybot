import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** Transactional, content-free change notice. Readers must recheck current resource access. */
export async function integrationEvent(ctx: MutationCtx, workspaceId: Id<"workspaces">, kind: string, resource: Id<"records"> | Id<"pages"> | Id<"chatMessages">) {
	const workspace = await ctx.db.get(workspaceId);
	if (!workspace) return;
	const sequence = (workspace.integrationEventSequence ?? 0) + 1;
	await ctx.db.patch(workspaceId, { integrationEventSequence: sequence });
	await ctx.db.insert("integrationEvents", { workspaceId, sequence, kind, resource, expiresAt: Date.now() + 7 * 86400000 });
}
