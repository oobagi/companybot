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
	"members.manage": { roles: ["owner"], label: "manage members" },
	"agents.manage": { roles: ["owner"], label: "change agents" },
	"plugins.manage": { roles: ["owner"], label: "manage plugins" },
	/** Connect your own account to a plugin that uses personal connections. */
	"plugins.connect": { roles: ["owner", "member"], label: "connect plugins" },
	"skills.manage": { roles: ["owner"], label: "manage skills" },
	"automations.manage": { roles: ["owner"], label: "manage automations" },
	"memory.team.write": { roles: ["owner"], label: "change team memories" },
	"memory.all.read": { roles: ["owner"], label: "read everyone's memories" },
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
