import { type CustomConnectorInput, customConnectorId, validateCustomConnector } from "@companybot/core";
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { cascading } from "./cascade";
import { customRow, fromRow } from "./connectorAccess";
import { install, installOf, uninstall } from "./connectors";
import { type Member, requirePermission } from "./lib";

// A workspace's own connectors (#257): someone with connectors.manage adds an MCP server by URL.
// It's then installed, connected and used exactly like a catalog connector (connectors.ts), found
// through `connectorsIn`/`connectorIn` (connectorAccess.ts), for this workspace only. Its URL is
// checked here on every save, and resolved and checked again before every connection (core
// `connectorFetch`, connectors.fetchFor).

const fields = {
	name: v.string(),
	description: v.string(),
	url: v.string(),
	transport: v.union(v.literal("http"), v.literal("sse")),
	connection: v.union(v.literal("workspace"), v.literal("personal")),
	auth: v.union(
		v.object({ type: v.literal("none") }),
		v.object({ type: v.literal("api_key"), header: v.string(), prefix: v.optional(v.string()), label: v.string() }),
		v.object({ type: v.literal("oauth") }),
	),
};
const input = v.object(fields);

/** Trimmed and checked, or a ConvexError saying what to fix. */
function tidy(raw: Infer<typeof input>): CustomConnectorInput {
	const auth: CustomConnectorInput["auth"] =
		raw.auth.type === "api_key"
			? { type: "api_key", header: raw.auth.header.trim(), label: raw.auth.label.trim(), ...(raw.auth.prefix && { prefix: raw.auth.prefix }) }
			: raw.auth;
	const value = { ...raw, name: raw.name.trim(), description: raw.description.trim(), url: raw.url.trim(), auth };
	const problem = validateCustomConnector(value);
	if (problem) throw new ConvexError(problem);
	return value;
}

async function requireCustom(ctx: MutationCtx, member: Member, connectorId: string) {
	const row = await customRow(ctx, member.workspaceId, connectorId);
	if (!row) throw new ConvexError("That connector isn't in this workspace anymore.");
	return row;
}

/** Adds one, installed for the Member role (owners always can), like installing from the catalog. Returns its id. */
export const create = mutation({
	args: { connector: input },
	handler: async (ctx, args): Promise<string> => {
		const member = await requirePermission(ctx, "connectors.manage");
		const value = tidy(args.connector);
		const mine = await ctx.db
			.query("customConnectors")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
			.collect();
		if (mine.length >= 50) throw new ConvexError("This workspace has 50 connectors of its own. Remove one first.");
		// Its "custom-" prefix keeps it clear of catalog ids and built-in tool groups.
		const connectorId = customConnectorId(value.name, mine.map((c) => c.connectorId));
		// One that was just removed under this id may still be deleting its rules: wait, so none come back.
		if (await cascading(ctx, "connectorInstall", { workspaceId: member.workspaceId, connectorId })) throw new ConvexError("A connector with this name was just removed. Try again in a minute.");
		const now = Date.now();
		const id = await ctx.db.insert("customConnectors", { workspaceId: member.workspaceId, connectorId, ...value, createdBy: member.userId, updatedBy: member.userId, updatedAt: now });
		await install(ctx, member, fromRow((await ctx.db.get(id))!));
		return connectorId;
	},
});

/** What a connection depends on: changing any of these points its accounts and rules at something else. The key's label is only a name. */
const serverOf = ({ url, transport, connection, auth }: Pick<Doc<"customConnectors">, "url" | "transport" | "connection" | "auth">) =>
	JSON.stringify([url, transport, connection, auth.type, auth.type === "api_key" ? [auth.header, auth.prefix ?? ""] : null]);

/**
 * Saves changes. A new server, transport, account type or sign-in on an installed one starts it
 * strict: its accounts, Always/Never rules, locks and tool list are deleted, as on uninstall, and it
 * stays installed for the same roles. A new name or description changes only those.
 */
export const update = mutation({
	args: { connectorId: v.string(), connector: input },
	handler: async (ctx, { connectorId, connector }) => {
		const member = await requirePermission(ctx, "connectors.manage");
		const row = await requireCustom(ctx, member, connectorId);
		const value = tidy(connector);
		await ctx.db.patch(row._id, { ...value, updatedBy: member.userId, updatedAt: Date.now() });
		if (serverOf(row) === serverOf(value)) return { reset: false };
		const existing = await installOf(ctx, member.workspaceId, connectorId);
		if (!existing) return { reset: false };
		// Uninstalled under its old definition (labels say the old name), then installed again for the same roles.
		await uninstall(ctx, fromRow(row), existing);
		await ctx.db.insert("connectorInstalls", { workspaceId: member.workspaceId, connectorId, roles: existing.roles, installedBy: member.userId });
		return { reset: true };
	},
});

/** Removes it: uninstalled as from the catalog (accounts, rules, locks go), then deleted. Agents' grants of it stop matching anything. */
export const remove = mutation({
	args: { connectorId: v.string() },
	handler: async (ctx, { connectorId }) => {
		const member = await requirePermission(ctx, "connectors.manage");
		const row = await requireCustom(ctx, member, connectorId);
		const existing = await installOf(ctx, member.workspaceId, connectorId);
		if (existing) await uninstall(ctx, fromRow(row), existing);
		await ctx.db.delete(row._id);
	},
});
