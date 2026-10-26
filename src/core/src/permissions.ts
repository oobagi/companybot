import type { Actor, Role } from "./types";

/**
 * Every workspace-level action and the roles allowed to take it. This is the one
 * place to change who can do what; the backend checks it with `requirePermission`.
 *
 * Add a permission here before adding a feature that needs one. Adding a role
 * means adding it to `Role` and to each list below that it should have.
 */
export const permissions = {
	"workspace.manage": { roles: ["owner"], label: "change workspace settings" },
	/** Delete the workspace and everything in it. */
	"workspace.delete": { roles: ["owner"], label: "delete the workspace" },
	"members.manage": { roles: ["owner"], label: "manage members" },
	"agents.manage": { roles: ["owner"], label: "change agents" },
	"connectors.manage": { roles: ["owner"], label: "manage connectors" },
	/** Lock agent actions for everyone: always ask, block, or lift a default lock (action-rules.ts). */
	"actions.lock": { roles: ["owner"], label: "lock agent actions" },
	/** Connect your own account to a connector that uses personal connections. */
	"connectors.connect": { roles: ["owner", "member"], label: "connect connectors" },
	/** Install library skills, and change or delete anyone's (`canEditMade`). */
	"skills.manage": { roles: ["owner"], label: "manage skills" },
	/** Make your own skills. You can always change and delete the ones you made. */
	"skills.create": { roles: ["owner", "member"], label: "make skills" },
	/** Install library automations, and change or delete anyone's (`canEditMade`). */
	"automations.manage": { roles: ["owner"], label: "manage automations" },
	/** Make your own automations. You can always change and delete the ones you made. */
	"automations.create": { roles: ["owner", "member"], label: "make automations" },
	"memory.team.write": { roles: ["owner"], label: "change team memories" },
	/** Add, change, archive and restore records (clients, deals, tasks…), and undo changes. */
	"records.edit": { roles: ["owner", "member"], label: "change records" },
	/** Add fields to a record type. You can always change and archive the ones you added. */
	"fields.create": { roles: ["owner", "member"], label: "add fields" },
	/** Add record types, and change or archive anyone's fields (`canEditMade`). */
	"fields.manage": { roles: ["owner"], label: "manage fields and record types" },
	"channels.create": { roles: ["owner", "member"], label: "create channels" },
	/** Rename, archive, and add members to any channel. Creators can always manage their own (`canManageChannel`). */
	"channels.manage": { roles: ["owner"], label: "manage channels" },
} as const satisfies Record<string, { roles: readonly Role[]; label: string }>;

export type Permission = keyof typeof permissions;

export function can(who: Actor | Role, permission: Permission): boolean {
	const role = typeof who === "string" ? who : who.role;
	return (permissions[permission].roles as readonly Role[]).includes(role);
}

/** The message shown when someone lacks a permission. */
export const deniedMessage = (permission: Permission) =>
	`You don't have permission to ${permissions[permission].label}. Ask a workspace owner.`;

/** Whether someone can rename a channel or add people to it: `channels.manage`, or they created it. */
export function canManageChannel(who: Actor, channel: { createdBy: string }): boolean {
	return can(who, "channels.manage") || channel.createdBy === who.userId;
}

/** Makers can edit their own; managers can edit anyone's or library installs. */
export function canEditMade(who: Actor, managePermission: "skills.manage" | "automations.manage" | "fields.manage", createdBy?: string): boolean {
	return can(who, managePermission) || (!!createdBy && createdBy === who.userId);
}

export const madeEditDenied = "Only the person who made this or an owner can change it.";
