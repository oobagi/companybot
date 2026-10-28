import type { Actor, Role } from "./types";

export type { Role } from "./types";

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
	/** Add, change and delete (to Trash) any team memory, and restore old versions. Wiki-style: anyone can fix a wrong fact; history undoes it. */
	"memory.team.write": { roles: ["owner", "member"], label: "change team memories" },
	/** Add, change, delete (to Trash) and restore records (clients, deals, tasks…), and undo changes. */
	"records.edit": { roles: ["owner", "member"], label: "change records" },
	/** Write, rename, delete (to Trash) and restore pages, and restore old versions (wiki/pages.md). */
	"pages.edit": { roles: ["owner", "member"], label: "change pages" },
	/** Add fields to a database. You can always change and delete the ones you added. */
	"fields.create": { roles: ["owner", "member"], label: "add fields" },
	/** Add and delete databases, and change or delete anyone's fields (`canEditMade`). */
	"fields.manage": { roles: ["owner"], label: "manage fields and databases" },
	"channels.create": { roles: ["owner", "member"], label: "create channels" },
	/** Rename, delete, and add members to any channel. Creators can always manage their own (`canManageChannel`). */
	"channels.manage": { roles: ["owner"], label: "manage channels" },
	/** Delete forever from Trash (wiki/data.md#trash). Agents never delete forever. */
	"trash.manage": { roles: ["owner"], label: "manage Trash" },
} as const satisfies Record<string, { roles: readonly Role[]; label: string }>;

export type Permission = keyof typeof permissions;

export function can(who: Actor | Role, permission: Permission): boolean {
	const role = typeof who === "string" ? who : who.role;
	return (permissions[permission].roles as readonly Role[]).includes(role);
}

/** The message shown when someone lacks a permission. */
export const deniedMessage = (permission: Permission) =>
	`You don't have permission to ${permissions[permission].label}. Ask a workspace owner.`;

/** Whether someone can rename or delete a channel, or add people to it: `channels.manage`, or they created it. */
export function canManageChannel(who: Actor, channel: { createdBy: string }): boolean {
	return can(who, "channels.manage") || channel.createdBy === who.userId;
}

/** Makers can edit their own; managers can edit anyone's or library installs. */
export function canEditMade(who: Actor, managePermission: "skills.manage" | "automations.manage" | "fields.manage", createdBy?: string): boolean {
	return can(who, managePermission) || (!!createdBy && createdBy === who.userId);
}

export const madeEditDenied = "Only the person who made this or an owner can change it.";

export const trashKinds = ["record", "database", "field", "page", "channel", "agent", "skill", "automation", "memory"] as const;
export type TrashKind = (typeof trashKinds)[number];

/**
 * Who can move an item to Trash, and so back out of it, whoever deleted it (Google Drive's shared
 * drives work this way). `madeBy`: who made it, for kinds whose makers manage their own (a library
 * skill or automation has none). The one place these rules meet; trashOps.canRestore uses it.
 */
export function canTrash(who: Actor, kind: TrashKind, madeBy?: string): boolean {
	switch (kind) {
		case "record":
			return can(who, "records.edit");
		case "page":
			return can(who, "pages.edit");
		case "memory":
			return can(who, "memory.team.write");
		case "database":
			return can(who, "fields.manage");
		case "agent":
			return can(who, "agents.manage");
		case "field":
			return canEditMade(who, "fields.manage", madeBy);
		case "skill":
			return canEditMade(who, "skills.manage", madeBy);
		case "automation":
			return canEditMade(who, "automations.manage", madeBy);
		case "channel":
			return canManageChannel(who, { createdBy: madeBy ?? "" });
	}
}
