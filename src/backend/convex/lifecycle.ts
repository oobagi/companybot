import { searchTextOf } from "@companybot/core";
import type { IndexNames, NamedTableInfo } from "convex/server";
import { internal } from "./_generated/api";
import type { DataModel, Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { privateTo } from "./automationOps";
import { startCascade } from "./cascade";
import { hasLiveOwner, liveWorkspace, pinLegacyWorkspace } from "./lib";
import { deletePage, pageOfRecord } from "./pageOps";
import { toField } from "./recordOps";

// What happens to every table's rows when what they belong to goes: a workspace is deleted,
// a member removed, an account erased, a connector or automation uninstalled, a page deleted, or
// a record, database, field, channel or agent deleted for good from Trash (trash.ts). cascade.ts
// runs it. Every table must be listed (tests/lifecycle.test.ts fails otherwise), so a new
// table can't ship until someone decides what happens to its rows. See wiki/architecture.md#data-lifecycle.

/** What's going. Each cascade deletes the rows its scope lists; a workspace's deletes the workspace last. */
export type Scope = Doc<"cascades">["scope"];
/** The ids naming what's going, read by each edge's `eq`. */
export type Root = Doc<"cascades">["root"];

/** Reads a row by id, counted against the cascade run's read budget. */
export type Get = {
	<T extends TableNames>(id: Id<T>): Promise<Doc<T> | null>;
	/** Small text-field catalog, cached and counted against the same budget. */
	searchFields(typeId: Id<"recordTypes">): Promise<Doc<"recordFields">[]>;
};

/** One range of one index: its rows are deleted (or patched, with `scrub`) when the scope's root goes. */
export type Edge<T extends TableNames> = {
	index: IndexNames<NamedTableInfo<DataModel, T>>;
	/** The index's leading fields, valued from the root key of the same name, or `[field, root key]`. */
	eq: (keyof Root | [string, keyof Root])[];
	/** Only rows this passes. */
	where?: (get: Get, row: Doc<T>, root: Root) => boolean | Promise<boolean>;
	/** Patch rows instead of deleting them. */
	scrub?: (row: Doc<T>, get: Get, root: Root) => Partial<Doc<T>> | Promise<Partial<Doc<T>>>;
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

/** A record's page body goes with it. */
async function deleteBody(ctx: MutationCtx, row: Doc<"records">) {
	const page = await pageOfRecord(ctx, row.workspaceId, row._id);
	if (page) await deletePage(ctx, page._id);
}

/** A page's content is the prosemirrorSync component's, deleted by the component a little at a time. */
const deleteContent = (ctx: MutationCtx, row: Doc<"pages">) => ctx.scheduler.runAfter(0, internal.pageSync.deleteDoc, { id: row._id });

/** The field being deleted, read once per run. */
const fieldOf = async (get: Get, root: Root) => await get(root.fieldId!);

/** Ends access to a workspace at once (memberOf refuses it), then deletes it in a cascade. */
export async function removeWorkspace(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
	await ctx.db.patch(workspaceId, { deleting: true });
	// Old apps' pins are set as the cascade deletes each membership (below); until then they act nowhere.
	await startCascade(ctx, "workspace", { workspaceId });
}

/**
 * An erased account leaves a workspace: what was theirs alone goes as on removal. One left with
 * no owner goes too. eraseAccount refuses a sole owner while others are in it, and invites to it
 * can't be accepted (workspace.ts invitesFor), so that's one only they were in.
 */
async function leaveErased(ctx: MutationCtx, row: Doc<"members">) {
	if (!(await liveWorkspace(ctx, row.workspaceId))) return;
	if (await hasLiveOwner(ctx, row.workspaceId)) await startCascade(ctx, "member", { workspaceId: row.workspaceId, userId: row.userId });
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
	modelCatalog: { keep: "AI Gateway's model list, shared by every workspace. Names no person or workspace." },
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
	// An agent deleted from Trash goes last in its own cascade, after its versions, memories, sessions and channel seats.
	// What it said and did stays (messages, activity, history), shown as "Agent".
	agents: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		keep: "Agents are the workspace's. Who last saved one stays on it.",
	},
	agentVersions: {
		childOf: { table: "agents", index: "by_agent", field: "agentId" },
		agent: { index: "by_agent", eq: ["agentId"] },
	},
	memories: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		agent: { index: "by_agent_scope", eq: ["agentId"] },
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

	skillInstalls: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		keep: "Skills people made are the workspace's: they stay when their maker leaves. Deleting one forever from Trash deletes its row.",
	},

	// ---- Chat ----
	// A channel deleted from Trash goes last in its own cascade, after its messages, seats and agent sessions.
	chats: { workspace: { index: "by_workspace", eq: ["workspaceId"] } },
	chatMembers: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		channel: { index: "by_chat", eq: ["chatId"] },
		member: { index: "by_workspace", eq: ["workspaceId", "userId"], where: inChannel },
		agent: { index: "by_agent", eq: ["agentId"], where: inChannel },
	},
	chatMessages: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		channel: { index: "by_chat_thread", eq: ["chatId"] },
		// Deleting a message clears it but keeps the row (messages.remove). What agents already saw of a
		// deleted or edited message stays in their sessions: a product decision is pending.
		keep: "Team history: what someone said stays when they leave; once their account is erased it shows as a former member's.",
	},
	typing: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		member: { index: "by_workspace", eq: ["workspaceId", "userId"] },
		channel: { index: "by_place", eq: ["chatId"] },
	},
	reactions: { childOf: { table: "chatMessages", index: "by_message", field: "messageId" } },
	userMentions: {
		childOf: { table: "chatMessages", index: "by_message", field: "messageId" },
		member: { index: "by_user_chat", eq: ["userId"], where: (get, row, root) => inWorkspace(get, row.chatId, root) },
	},

	// ---- Agent runs ----
	agentTurns: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		channel: { index: "by_chat", eq: ["chatId"] },
		keep: "A queued turn acting for someone who left fails when it runs (runningTurn reads membership fresh).",
	},
	agentSessions: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		channel: { index: "by_chat", eq: ["chatId"] },
		agent: { index: "by_place", eq: ["agentId"] },
	},
	agentActivity: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		// Results show only to the person it acted for (their inbox, a private channel): erasing them clears those.
		user: { index: "by_actor", eq: [["actorId", "userId"]], scrub: () => ({ output: undefined }) },
		keep: "The workspace's log of what agents did. Results show only to the person it acted for, so once they leave nobody sees them. A deleted channel's entries stay, hidden with it (as private as its chat).",
	},
	approvals: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		user: { index: "by_actor", eq: [["actorId", "userId"]], scrub: () => ({ result: undefined }) },
		keep: "Only the person it acted for can decide one; a removed person's expire undecided, as do ones in a deleted channel.",
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
		keep: "Removing one, or deleting one people made forever from Trash, deletes the row before the cascade starts (removeInstall). In Trash, nothing triggers it.",
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
	// A record, database or field deleted from Trash (trash.ts) goes last in its own cascade.
	recordTypes: { workspace: { index: "by_workspace", eq: ["workspaceId"] } },
	databaseViews: {
		childOf: { table: "recordTypes", index: "by_type", field: "typeId" },
		database: { index: "by_type", eq: ["typeId"] },
	},
	recordFields: {
		childOf: { table: "recordTypes", index: "by_type", field: "typeId" },
		database: { index: "by_type", eq: ["typeId"] },
	},
	records: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		database: { index: "by_type", eq: ["typeId"], onDelete: deleteBody },
		// A deleted field's values leave every record in its database, in Trash or not, so a new field can reuse its key.
		field: {
			index: "by_type",
			eq: ["typeId"],
			where: async (get, row, root) => {
				const field = await fieldOf(get, root);
				return !!field && field.key in row.values;
			},
			scrub: async (row, get, root) => {
				const field = await fieldOf(get, root);
				const { [field!.key]: _, ...values } = row.values;
				const fields = await get.searchFields(row.typeId);
				return { values, searchText: searchTextOf(fields.filter((f) => f._id !== root.fieldId).map(toField), values) };
			},
		},
		keep: "Records are the workspace's: deleting one moves it to Trash. Who made or changed them stays in history.",
	},
	recordValues: {
		childOf: { table: "records", index: "by_record", field: "recordId" },
		record: { index: "by_record", eq: ["recordId"] },
		field: { index: "by_field_at", eq: ["fieldId"] },
	},
	recordHistory: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		record: { index: "by_record", eq: ["recordId"] },
		database: { index: "by_type", eq: ["typeId"] },
		field: { index: "by_field", eq: ["fieldId"] },
	},
	// Deleting a message deletes its rows here too (messages.remove).
	recordMentions: {
		channel: { index: "by_chat", eq: ["chatId"] },
		childOf: { table: "records", index: "by_record", field: "recordId" },
		record: { index: "by_record", eq: ["recordId"] },
	},

	// ---- Pages ----
	pages: {
		workspace: { index: "by_workspace", eq: ["workspaceId"], onDelete: deleteContent },
		// A record's body goes with it.
		record: { index: "by_workspace", eq: ["workspaceId", "recordId"], onDelete: deleteContent },
		keep: "Pages are the workspace's, like records. Deleting one forever (trash.ts) deletes its row first, then its content and a page cascade.",
	},
	pageVersions: {
		childOf: { table: "pages", index: "by_page", field: "pageId" },
		page: { index: "by_page", eq: ["pageId"] },
	},

	trash: {
		workspace: { index: "by_workspace", eq: ["workspaceId"] },
		// Its records' and fields' entries: they go with it.
		database: { index: "by_type", eq: ["typeId"] },
		keep: "Deleting forever deletes the entry first (trash.ts). Who deleted something stays, as a former member once they leave.",
	},

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
