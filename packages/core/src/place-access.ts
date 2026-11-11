import type { Access } from "./types";

/**
 * Who can access a place (a channel, database or page), like sharing in Google Drive or Notion:
 * Everyone, or chosen roles, each at View or Edit (Post, for channels). Not on the list: no access,
 * so the place shows nowhere. Owners always have Edit. No list is Everyone at Edit, so nothing
 * changes until someone restricts a place. See wiki/permissions.md#who-can-access.
 */
export const accessLevels = ["view", "edit"] as const;
export type AccessLevel = (typeof accessLevels)[number];

/** Stands for every role in the workspace. */
export const EVERYONE = "everyone";

/** One line of a place's list: `role` is a role id, or EVERYONE. */
export interface AccessEntry {
	role: string;
	level: AccessLevel;
}

export type PlaceKind = "channel" | "database" | "page" | "folder" | "file";

/** What no list means: anyone in the workspace can view and change it. */
export const OPEN_ACCESS: readonly AccessEntry[] = [{ role: EVERYONE, level: "edit" }];

/** The most someone may do in a place with this list: `edit`, `view`, or null (no access). */
export function levelIn(who: Access, list: readonly AccessEntry[] | undefined): AccessLevel | null {
	if (who.owner) return "edit";
	let level: AccessLevel | null = null;
	for (const entry of list ?? OPEN_ACCESS) {
		if (entry.role !== EVERYONE && !who.roles.includes(entry.role)) continue;
		if (entry.level === "edit") return "edit";
		level = "view";
	}
	return level;
}

/** Whether `level` is enough for `need`. */
export const reaches = (level: AccessLevel | null, need: AccessLevel) => level === "edit" || (level === "view" && need === "view");

/** Whether a list is anything but the default, so the sidebar shows a lock. */
export const isRestricted = (list: readonly AccessEntry[] | undefined) =>
	!!list && !(list.length === 1 && list[0]!.role === EVERYONE && list[0]!.level === "edit");

type RoleLike = { id: string; name: string; owner: boolean };

/**
 * The roles that reach `need` in a place, by name, Owners last: "Office and Owners". Everyone on
 * the list at that level reads as "everyone". Roles that no longer exist are skipped.
 */
export function whoCan(list: readonly AccessEntry[] | undefined, roles: readonly RoleLike[], need: AccessLevel = "view"): string {
	const entries = (list ?? OPEN_ACCESS).filter((e) => reaches(e.level, need));
	if (entries.some((e) => e.role === EVERYONE)) return "Everyone";
	const names = roles.filter((r) => !r.owner && entries.some((e) => e.role === r.id)).map((r) => r.name);
	return names.length ? `${names.join(", ")} and Owners` : "Owners";
}

const verbs: Record<PlaceKind, Record<AccessLevel, string>> = {
	channel: { view: "see", edit: "post in" },
	database: { view: "see", edit: "change" },
	page: { view: "see", edit: "edit" },
	folder: { view: "see", edit: "change" },
	file: { view: "see", edit: "change" },
};

/**
 * What a refusal says, naming who has access so the person (or an agent, for its person) knows
 * whom to ask: "Only Office and Owners can see Deals." `name` is how the place reads: "#sales", "Deals".
 */
export const placeDeniedMessage = (kind: PlaceKind, name: string, list: readonly AccessEntry[] | undefined, roles: readonly RoleLike[], need: AccessLevel) =>
	`Only ${whoCan(list, roles, need)} can ${verbs[kind][need]} ${name}.`;

/**
 * Whether saving `next` takes away the person's own Edit (Post) there. Only Owners may do that, since
 * nobody else could undo it: a Member setting #general to View would lock the team out with them.
 */
export const losesOwnEdit = (who: Access, next: readonly AccessEntry[] | undefined) => !who.owner && !reaches(levelIn(who, next), "edit");

/** The refusal (and the app's hint) for a change that `losesOwnEdit`. */
export const ownEditMessage = (kind: PlaceKind) => `You'd lose ${kind === "channel" ? "Post" : "edit"} access. Ask an Owner.`;

/**
 * A list as saved: roles in the workspace (`roleIds`) or Everyone, each once, at most one level each.
 * Owners always have Edit, so naming the Owner role adds nothing and is dropped. Throws a plain message.
 */
export function cleanAccess(list: readonly AccessEntry[], roleIds: readonly string[], ownerRoleId: string): AccessEntry[] {
	const seen = new Set<string>();
	const out: AccessEntry[] = [];
	for (const entry of list) {
		if (entry.role !== EVERYONE && !roleIds.includes(entry.role)) throw new Error("Role not found.");
		if (!accessLevels.includes(entry.level)) throw new Error("Pick View or Edit.");
		if (entry.role === ownerRoleId || seen.has(entry.role)) continue;
		seen.add(entry.role);
		out.push({ role: entry.role, level: entry.level });
	}
	return out;
}

/**
 * Whether `next` lets anyone further in than `before`: someone in no role, or in any one role, reaches
 * more. Someone's reach is the most any of their roles gives, so checking roles one at a time covers
 * every mix of them.
 */
export function widens(before: readonly AccessEntry[] | undefined, next: readonly AccessEntry[] | undefined, roleIds: readonly string[]) {
	const rank = (level: AccessLevel | null) => (level === "edit" ? 2 : level === "view" ? 1 : 0);
	return [[], ...roleIds.map((id) => [id])].some((roles) => rank(levelIn({ roles, owner: false, permissions: [] }, next)) > rank(levelIn({ roles, owner: false, permissions: [] }, before)));
}
