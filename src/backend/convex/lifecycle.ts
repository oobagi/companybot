import type { IndexNames, NamedTableInfo } from "convex/server";
import type { DataModel, Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { privateTo } from "./automationOps";
import { startCascade } from "./cascade";
import { liveWorkspace, pinLegacyWorkspace } from "./lib";

// What happens to every table's rows when what they belong to goes: a workspace is deleted,
// a member removed, an account erased, a connector or automation uninstalled. cascade.ts
// runs it. Every table must be listed (tests/lifecycle.test.ts fails otherwise), so a new
// table can't ship until someone decides what happens to its rows. See wiki/architecture.md#data-lifecycle.

/** What's going. Each cascade deletes the rows its scope lists; a workspace's deletes the workspace last. */
export type Scope = Doc<"cascades">["scope"];
/** The ids naming what's going, read by each edge's `eq`. */
export type Root = Doc<"cascades">["root"];

/** Reads a row by id, counted against the cascade run's read budget. */
export type Get = <T extends TableNames>(id: Id<T>) => Promise<Doc<T> | null>;

/** One range of one index: its rows are deleted (or patched, with `scrub`) when the scope's root goes. */
export type Edge<T extends TableNames> = {
	index: IndexNames<NamedTableInfo<DataModel, T>>;
	/** The index's leading fields, valued from the root key of the same name, or `[field, root key]`. */
	eq: (keyof Root | [string, keyof Root])[];
	/** Only rows this passes. */
	where?: (get: Get, row: Doc<T>, root: Root) => boolean | Promise<boolean>;
	/** Patch rows instead of deleting them. */
	scrub?: (row: Doc<T>) => Partial<Doc<T>>;
	/** Runs just before each row is deleted, in the same transaction. Keep it to a few small reads. */
	onDelete?: (ctx: MutationCtx, row: Doc<T>, root: Root) => Promise<unknown>;
};

export type Lifecycle<T extends TableNames> = { [S in Scope]?: Edge<T> } & {
	/** Why the scopes not listed leave its rows alone. Required when no scope is. */
	keep?: string;
	/** Deleted with each row of `table`, wherever one is deleted: the rows whose `field` is its id. One level only. */
	childOf?: { table: TableNames; index: IndexNames<NamedTableInfo<DataModel, T>>; field: string };
};

/** A channel seat, not a DM: DMs keep people who left as past participants. */
const inChannel = async (get: Get, row: { chatId: Id<"chats"> }) => (await get(row.chatId))?.kind === "channel";
const inWorkspace = async (get: Get, id: Id<"chats"> | Id<"automationInstalls">, root: Root) => (await get(id))?.workspaceId === root.workspaceId;

/** Ends access to a workspace at once (memberOf refuses it), then deletes it in a cascade. */
export async function removeWorkspace(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
	await ctx.db.patch(workspaceId, { deleting: true });
	// Old apps' pins are set as the cascade deletes each membership (below); until then they act nowhere.
	await startCascade(ctx, "workspace", { workspaceId });
}

/** An erased account leaves a workspace: one only they were in goes too; elsewhere, what was theirs alone goes as on removal. */
async function leaveErased(ctx: MutationCtx, row: Doc<"members">) {
	if (!(await liveWorkspace(ctx, row.workspaceId))) return;
	const others = await ctx.db
		.query("members")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", row.workspaceId))
		.take(2);
	if (others.length > 1) await startCascade(ctx, "member", { workspaceId: row.workspaceId, userId: row.userId });
	else await removeWorkspace(ctx, row.workspaceId);
}

export const lifecycle: { [T in TableNames]: Lifecycle<T> } = {
	// ---- Convex Auth ----
	users: {
		keep: "Never deleted: ~20 tables point at people. Erasing an account (workspace.eraseAccount) scrubs it at once to `{ erasedAt }`, so they show as a former member and a sign-in from before acts as nobody.",
	},
	authAccounts: {
		// eraseAccount also deletes these at once, so their email can't sign back in to the old account.
		user: { index: "userIdAndProvider", eq: ["userId"] },
	},
	authVerificationCodes: { childOf: { table: "authAccounts", index: "accountId", field: "accountId" } },
	authSessions: { user: { index: "userId", eq: ["userId"] } },
	authRefreshTokens: { childOf: { table: "authSessions", index: "sessionId", field: "sessionId" } },
	authVerifiers: { keep: "Sign-in handshakes Convex Auth deletes as they're used. They name no person or workspace." },
	authRateLimits: { keep: "Sign-in attempt counters keyed by email: eraseAccount deletes the person's at once, while it still knows their email." },
	localSignInCodes: { keep: "Local backends only (`pnpm dev`): the latest code per email. eraseAccount deletes the person's at once, like authRateLimits." },

	// ---- Workspaces and people ----
	workspaces: { keep: "Its own cascade deletes it last, once everything in it is gone (cascade.ts)." },
	members: {
		// COMPAT(0.1.0-alpha.7): pin before the membership goes, so old apps act nowhere rather than in another workspace.
		workspace: { index: "by_workspace", eq: ["workspaceId"], onDelete: (ctx, row) => pinLegacyWorkspace(ctx, row.userId) },
		user: { index: "by_user", eq: ["userId"], onDelete: leaveErased },
		keep: "Removing someone deletes their row before the cascade starts (dropMember), so access ends at once.",
	},
	invites: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		keep: "Invites are for an email, not an account: they outlive the person who sent them.",
	},
	inviteEmails: { workspace: { index: "by_workspace", eq: ["workspaceId"] } },
	legacyWorkspaces: {
		user: { index: "by_user", eq: ["userId"] },
		keep: "A pin to a deleted workspace stays, so apps from before switching act nowhere, never in another workspace (legacyMemberOf).",
	},
	preferences: {
		user: { index: "by_user", eq: ["userId"] },
		// "Last used" pointing at a deleted workspace: the app opens another.
		workspace: { index: "by_workspace", eq: ["workspaceId"], scrub: () => ({ workspaceId: undefined }) },
	},

	// ---- Agents and memory ----
	agents: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		keep: "Agents are the workspace's. Who last saved one stays on it.",
	},
	agentVersions: { childOf: { table: "agents", index: "by_agent", field: "agentId" } },
	memories: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		// Personal memories are their owner's alone. Team memories they wrote stay with the team.
		member: { index: "by_owner", eq: [["ownerId", "userId"], "workspaceId"] },
	},

	// ---- Connectors ----
	connectorInstalls: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		keep: "Uninstalling deletes the row before the cascade starts, so access ends at once.",
	},
	connectorConnections: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		// Their own accounts. The workspace's (userId null) stay, whoever connected them.
		member: { index: "by_user", eq: ["userId", "workspaceId"] },
		// In every workspace, including ones they left before removal deleted them.
		user: { index: "by_user", eq: ["userId"] },
		connectorInstall: { index: "by_workspace", eq: ["workspaceId", "connectorId"] },
	},
	// Sign-ins in progress. Finishing one also checks it started under the membership and install still there.
	connectorOAuthFlows: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		member: { index: "by_user", eq: ["userId", "workspaceId"] },
		user: { index: "by_user", eq: ["userId"] },
		connectorInstall: { index: "by_install", eq: ["connectorInstallId"] },
	},
	connectorTools: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		connectorInstall: { index: "by_workspace", eq: ["workspaceId", "connectorId"] },
	},
	pluginInstalls: { keep: "Legacy, emptied by the connector* migrations; dropped with them." },
	pluginConnections: { keep: "Legacy, emptied by the connector* migrations; dropped with them." },
	pluginOAuthFlows: { keep: "Legacy, emptied by the connector* migrations; dropped with them." },

	skillInstalls: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		keep: "Skills people made are the workspace's: they stay when their maker leaves.",
	},

	// ---- Chat ----
	chats: { workspace: { index: "by_workspace", eq: ["workspaceId"] } },
	chatMembers: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		member: { index: "by_workspace", eq: ["workspaceId", "userId"], where: inChannel },
	},
	chatMessages: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		// Deleting a message clears it but keeps the row (messages.remove). What agents already saw of a
		// deleted or edited message stays in their sessions: a product decision is pending.
		keep: "Team history: what someone said stays when they leave; once their account is erased it shows as a former member's.",
	},
	reactions: { childOf: { table: "chatMessages", index: "by_message", field: "messageId" } },
	userMentions: {
		childOf: { table: "chatMessages", index: "by_message", field: "messageId" },
		member: { index: "by_user_chat", eq: ["userId"], where: (get, row, root) => inWorkspace(get, row.chatId, root) },
	},

	// ---- Agent runs ----
	agentTurns: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		keep: "A queued turn acting for someone who left fails when it runs (runningTurn reads membership fresh).",
	},
	agentSessions: { workspace: { index: "by_workspace", eq: ["workspaceId"] } },
	agentActivity: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		// Results show only to the person it acted for (their inbox, a private channel): erasing them clears those.
		user: { index: "by_actor", eq: [["actorId", "userId"]], scrub: () => ({ output: undefined }) },
		keep: "The workspace's log of what agents did. Results show only to the person it acted for, so once they leave nobody sees them.",
	},
	approvals: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		user: { index: "by_actor", eq: [["actorId", "userId"]], scrub: () => ({ result: undefined }) },
		keep: "Only the person it acted for can decide one; a removed person's expire undecided.",
	},

	// ---- Automations and permissions ----
	automationInstalls: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		// Just-them automations: nobody else can see or delete them (canView). Their grants go as on uninstall.
		member: {
			index: "by_workspace",
			eq: ["workspaceId"],
			where: (_get, row, root) => privateTo(row) === root.userId,
			onDelete: (ctx, row) => startCascade(ctx, "automationInstall", { automationInstallId: row._id }),
		},
		keep: "Removing one deletes the row before the cascade starts (removeInstall), so its webhook and schedule stop at once.",
	},
	automationSubscriptions: {
		childOf: { table: "automationInstalls", index: "by_install", field: "installId" },
		member: { index: "by_user", eq: ["userId"], where: (get, row, root) => inWorkspace(get, row.installId, root) },
		automationInstall: { index: "by_install", eq: [["installId", "automationInstallId"]] },
	},
	automationEvents: {
		childOf: { table: "automationInstalls", index: "by_install", field: "installId" },
		automationInstall: { index: "by_install", eq: [["installId", "automationInstallId"]] },
	},
	permissionRules: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		member: { index: "by_workspace", eq: ["workspaceId", "userId"] },
		connectorInstall: { index: "by_connector", eq: ["connectorInstallId"] },
		automationInstall: { index: "by_automation", eq: ["automationInstallId"] },
	},
	permissionLocks: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		connectorInstall: { index: "by_connector", eq: ["connectorInstallId"] },
		keep: "An owner's lock is the workspace's: it stays when they leave.",
	},

	// ---- Records ----
	recordTypes: { workspace: { index: "by_workspace", eq: ["workspaceId"] } },
	recordFields: { childOf: { table: "recordTypes", index: "by_type", field: "typeId" } },
	records: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		keep: "Records are the workspace's (archive, don't delete); who made or changed them stays in history.",
	},
	recordValues: { childOf: { table: "records", index: "by_record", field: "recordId" } },
	recordHistory: { workspace: { index: "by_workspace", eq: ["workspaceId"] } },
	// Deleting a message deletes its rows here too (messages.remove).
	recordMentions: { childOf: { table: "records", index: "by_record", field: "recordId" } },

	cascades: { keep: "The cascades themselves: each deletes its own row when it's done." },
};

export type Step = Edge<TableNames> & { table: TableNames };

/** A scope's edges, in the order above. */
export const edgesOf = (scope: Scope): Step[] =>
	Object.entries(lifecycle).flatMap(([table, rules]) => {
		const edge = (rules as Lifecycle<TableNames>)[scope];
		return edge ? [{ ...(edge as Edge<TableNames>), table: table as TableNames }] : [];
	});

/** Tables deleted with each row of `table`. */
export const childrenOf = (table: TableNames) =>
	Object.entries(lifecycle).flatMap(([child, rules]) => (rules.childOf?.table === table ? [{ ...rules.childOf, table: child as TableNames }] : []));
