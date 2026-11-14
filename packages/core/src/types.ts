import type { Permission } from "./permissions";

/** Every workspace has these two roles. Owner can do everything and can't be changed; Member is what new people get. */
export const builtInRoles = ["owner", "member"] as const;
export type BuiltInRole = (typeof builtInRoles)[number];

/** A workspace role as people and agents see it (backend `roles` table). */
export interface RoleInfo {
	id: string;
	name: string;
	/** The built-in Owner role: every permission, always. */
	owner: boolean;
	permissions: Permission[];
}

/** What someone may do in a workspace: the union of their roles' switches, or everything for an owner. */
export interface Access {
	/** Ids of the roles they hold. */
	roles: string[];
	/** Holds the built-in Owner role. */
	owner: boolean;
	permissions: Permission[];
}

/** The person an agent is acting for. */
export interface Actor extends Access {
	userId: string;
}
