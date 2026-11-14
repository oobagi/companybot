import { CUSTOM_PREFIX, type Connector, connectorCatalog, customConnector, findConnector } from "@companybot/core";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { type Member, UNSEEDED_MEMBER } from "./lib";

/** The role ids an install allows. Owners always can, so they're never listed. */
export function allowedRoles(member: Member, install: Doc<"connectorInstalls">): Id<"roles">[] {
	// COMPAT(0.1.0-alpha.10): installs list "owner"/"member" until migrations.customRolesConnectors
	// runs; read "member" as the Member role so nobody loses a connector mid-migration. Delete with it.
	const memberRole = member.workspaceRoles.find((r) => r.builtIn === "member")?.id;
	return install.roles.flatMap((r) => (r === "owner" ? [] : r === "member" ? (memberRole ? [memberRole] : member.workspaceRoles.length ? [] : [UNSEEDED_MEMBER]) : member.workspaceRoles.some((role) => role.id === r) ? [r] : []));
}

/** A custom connector's row as the Connector the rest of the app uses. */
export const fromRow = (row: Doc<"customConnectors">): Connector => customConnector(row.connectorId, row);

export const customRow = (ctx: QueryCtx, workspaceId: Id<"workspaces">, connectorId: string) =>
	ctx.db
		.query("customConnectors")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("connectorId", connectorId))
		.first();

/**
 * Every connector this workspace can see: the catalog plus its own (custom). Read wherever code
 * would iterate `connectorCatalog`, so custom ones show for their workspace and no other.
 */
export async function connectorsIn(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Connector[]> {
	const custom = await ctx.db
		.query("customConnectors")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	return [...connectorCatalog, ...custom.map(fromRow)];
}

/** One connector by id in this workspace: the catalog's, or its own. Use instead of `findConnector` in the backend. */
export async function connectorIn(ctx: QueryCtx, workspaceId: Id<"workspaces">, connectorId: string): Promise<Connector | undefined> {
	const fromCatalog = findConnector(connectorId);
	if (fromCatalog || !connectorId.startsWith(CUSTOM_PREFIX)) return fromCatalog;
	const row = await customRow(ctx, workspaceId, connectorId);
	return row ? fromRow(row) : undefined;
}
