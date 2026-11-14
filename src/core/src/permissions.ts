import type { Access, BuiltInRole } from "./types";

export type { Access, BuiltInRole, RoleInfo } from "./types";

/**
 * Every workspace-level action. Roles are workspace data (`roles` table): the built-in Owner can
 * do everything; every other role is a set of these switches, and someone holding several roles
 * gets every switch any of them has. The backend checks with `requirePermission`.
 *
 * `label` finishes "Only people with … can …" and names the switch in Settings → Members → Roles.
 * `member`: the built-in Member role's default. Member stores only the switches an owner flipped
 * (`roleSwitches`), so a new permission reaches every workspace's Member as its default, with no
 * migration. Default anything sensitive (money, people, settings, deleting for good) to false.
 * Custom roles store what's on; a new permission starts off for them.
 * `ownerOnly`: never a switch; only the Owner role has it.
 *
 * Add a permission here before adding a feature that needs one (wiki/extending.md).
 */
export const permissions = {
	"integrations.manage": { label: "create personal API tokens", member: false },
	"workspace.manage": { label: "change workspace settings", member: false },
	/** Delete the workspace and everything in it. */
	"workspace.delete": { label: "delete the workspace", ownerOnly: true },
	/** Erase everything in the workspace and start it again like new; its members, roles and settings stay. */
	"workspace.reset": { label: "reset the workspace", ownerOnly: true },
	/** Make, rename and delete roles and choose their switches. Owner-only, so nobody can give themselves more than an owner chose. */
	"roles.manage": { label: "change roles", ownerOnly: true },
	/** Reorder shared sidebar lists (channels, page siblings, databases, view tabs) and lay out the sidebar's sections. */
	"sidebar.arrange": { label: "rearrange shared sidebar lists", member: true },
	/** Invite and remove people and give them roles. Only owners give or take the Owner role, or remove an owner. */
	"members.manage": { label: "invite and remove people and change their roles", member: false },
	"agents.manage": { label: "change agents", member: false },
	"connectors.manage": { label: "install connectors and choose who can use them", member: false },
	/** Connect your own account to a connector that uses personal connections. */
	"connectors.connect": { label: "connect their own accounts to connectors", member: true },
	/** Lock agent actions for everyone: always ask, block, or lift a default lock (action-rules.ts). */
	"actions.lock": { label: "lock agent actions for everyone", member: false },
	/** Make, install, change and delete team skills. Personal ones are their maker's alone (`canTrash`, skills.ts). */
	"skills.edit": { label: "make and change team skills", member: false },
	/** Make, install, change and delete team automations. Personal ones are their maker's alone (`canEditAutomation`). */
	"automations.edit": { label: "make and change team automations", member: false },
	/** Add, change and delete (to Archive) any team memory, and restore old versions. Wiki-style: anyone can fix a wrong fact; history undoes it. */
	"memory.team.write": { label: "change team memories", member: true },
	/** Add, change, delete (to Archive) and restore records (clients, deals, tasks…), and undo changes. */
	"records.edit": { label: "add and change records", member: true },
	/** Write, rename, delete (to Archive) and restore pages, and restore old versions (wiki/pages.md). */
	"pages.edit": { label: "write and change pages, folders and files", member: true },
	/** Add, change and delete (to Archive) databases and their fields. */
	"fields.edit": { label: "add and change databases and fields", member: false },
	/** Make channels, and rename, delete and add people to any channel. */
	"channels.edit": { label: "make and change channels", member: true },
	/** Delete forever from Archive (wiki/data.md#trash). Agents never delete forever. */
	"trash.manage": { label: "delete things forever from Archive", member: false },
	/** Stop an agent's reply that's running for someone else. Anyone can always stop one running for them (turns.stop). */
	"turns.stopAny": { label: "stop agents working for someone else", member: false },
	/** See the whole workspace's AI usage and cost. Everyone sees their own share (usage.ts). */
	"usage.view": { label: "see the whole workspace's AI usage", member: false },
} as const satisfies Record<string, { label: string; member: boolean } | { label: string; ownerOnly: true }>;

export type Permission = keyof typeof permissions;

/** Switches a role can have, in the order Settings shows them. */
export const switches = (Object.keys(permissions) as Permission[]).filter((p) => !("ownerOnly" in permissions[p]));

/** What the built-in Member role has until an owner flips something. */
export const memberDefaults: Permission[] = switches.filter((p) => (permissions[p] as { member: boolean }).member);

/** Switches a role stores: Member's flips from its defaults, a custom role's own (absent is off). */
export type StoredSwitches = readonly { permission: Permission; on: boolean }[];

/** A role's switch when it stores nothing for it: Member's default, otherwise off. */
const baseline = (kind: BuiltInRole | undefined, p: Permission) => kind === "member" && memberDefaults.includes(p);

/** What a role allows: Owner everything; others each switch's stored value, else its baseline. */
export function roleSwitches(kind: BuiltInRole | undefined, stored: StoredSwitches): Permission[] {
	if (kind === "owner") return [...switches];
	return switches.filter((p) => stored.find((s) => s.permission === p)?.on ?? baseline(kind, p));
}

/** A role's stored switches after turning one on or off: only what differs from the baseline is kept. */
export function flipSwitch(kind: BuiltInRole | undefined, stored: StoredSwitches, permission: Permission, on: boolean) {
	const rest = stored.filter((s) => s.permission !== permission);
	return on === baseline(kind, permission) ? rest : [...rest, { permission, on }];
}

export function can(who: Access, permission: Permission): boolean {
	return who.owner || (!("ownerOnly" in permissions[permission]) && who.permissions.includes(permission));
}

/**
 * Whether someone may give or take a role (inviting with it, setting it, removing a person or cancelling an
 * invite that has it): Owners any; anyone else only Member, which everyone joins with, and roles they hold
 * themselves. A role you hold gives nobody more than you have: its switches, the places it opens and the
 * connectors it may use.
 */
export const canGrantRole = (who: Access, role: { id: string; builtIn?: BuiltInRole | null }) =>
	who.owner || role.builtIn === "member" || (role.builtIn !== "owner" && who.roles.includes(role.id));

/** Whether someone may use a connector allowed for these role ids. Owners can use every one. */
export const canUseConnector = (who: Access, allowed: readonly string[]) => who.owner || who.roles.some((r) => allowed.includes(r));

/** Names of the roles that have a permission, Owner last: what a refusal tells people to ask. */
export const rolesWith = (roles: readonly RoleLike[], permission: Permission) =>
	[...roles.filter((r) => !r.owner && !("ownerOnly" in permissions[permission]) && r.permissions.includes(permission)), ...roles.filter((r) => r.owner)].map((r) => r.name);

type RoleLike = { name: string; owner: boolean; permissions: readonly string[] };

/** "Owner", "Office or Owner", "Crew, Office or Owner". */
const either = (names: string[]) => (names.length < 2 ? (names[0] ?? "Owner") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`);

/** The message shown when someone lacks a permission, naming the workspace's roles that have it. */
export const deniedMessage = (permission: Permission, roles: readonly RoleLike[]) => {
	const names = rolesWith(roles, permission);
	return `Only people with the ${either(names)} role can ${permissions[permission].label}. Ask someone who has ${names.length > 1 ? "one of them" : "it"}.`;
};

/**
 * Who can change an automation. `privateTo`: who a personal one (made to run just for its maker)
 * belongs to. Nobody else can see it, so it's theirs to change whatever their roles; this is about
 * who can see it, not who made it. Team ones need the switch.
 */
export const canEditAutomation = (who: Access & { userId: string }, privateTo: string | null) =>
	privateTo ? privateTo === who.userId : can(who, "automations.edit");

export const trashKinds = ["record", "database", "field", "page", "folder", "file", "channel", "agent", "skill", "automation", "memory"] as const;
export type TrashKind = (typeof trashKinds)[number];

const trashPermission: Record<TrashKind, Permission> = {
	record: "records.edit",
	page: "pages.edit",
	folder: "pages.edit",
	file: "pages.edit",
	memory: "memory.team.write",
	database: "fields.edit",
	field: "fields.edit",
	agent: "agents.manage",
	skill: "skills.edit",
	automation: "automations.edit",
	channel: "channels.edit",
};

/**
 * Who can move an item to Archive, and so back out of it, whoever deleted it (Google Drive's shared
 * drives work this way): the kind's switch, or for an automation, `canEditAutomation`. The one place
 * these rules meet; trashOps.canRestore uses it.
 */
export function canTrash(who: Access & { userId: string }, kind: TrashKind, privateTo?: string | null): boolean {
	return kind === "skill" && privateTo ? who.userId === privateTo : kind === "automation" ? canEditAutomation(who, privateTo ?? null) : can(who, trashPermission[kind]);
}
