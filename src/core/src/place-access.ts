import { publicLevelProblem } from "./public-role";
import type { Access } from "./types";

/**
 * Who can access a place (a channel, database or page), like sharing in Google Drive or Notion:
 * Everyone, chosen roles or Public, each at View or Edit (Post, for channels), or, in a database, Add.
 * Not on the list: no access, so the place shows nowhere. Owners always have Edit. No list is Everyone
 * at Edit, so nothing changes until someone restricts a place. See wiki/permissions.md#who-can-access.
 *
 * - **View** sees everything in it. **Edit** sees and changes everything.
 * - **Add** (databases only) creates records and sees, changes or archives only the records you made, like
 *   your own Google Form response. It shows no one else's, and never changes fields or the database.
 * - **Public** is people outside the workspace (core public-role.ts). Everyone never includes them, and
 *   they can hold only View, or Add in a database (`publicLevelProblem`).
 */
export const accessLevels = ["view", "add", "edit"] as const;
export type AccessLevel = (typeof accessLevels)[number];
/** How far someone reaches into everything in a place. Add isn't on this scale: it reaches only your own records (`canAddIn`). */
export type ReadLevel = "view" | "edit";

/** Stands for every role in the workspace. Never people outside it. */
export const EVERYONE = "everyone";
/** Stands for the Public role: people outside the workspace who email or text an agent. */
export const PUBLIC = "public";

/** One line of a place's list: `role` is a role id, EVERYONE or PUBLIC. */
export interface AccessEntry {
	role: string;
	level: AccessLevel;
}

export type PlaceKind = "channel" | "database" | "page";

/** What no list means: anyone in the workspace can view and change it. Nobody outside. */
export const OPEN_ACCESS: readonly AccessEntry[] = [{ role: EVERYONE, level: "edit" }];

/** Who a Public turn is, for the same rules: the Public role and nothing else. */
export const PUBLIC_ACCESS: Access = { roles: [PUBLIC], owner: false, permissions: [] };

/** Someone outside the workspace (`PUBLIC_ACCESS`). */
export const isOutsider = (who: Access) => who.roles.includes(PUBLIC);

/** Whether a list entry is about this person. Everyone is every member, never someone outside; Public is only them. */
const isFor = (who: Access, entry: AccessEntry) => (entry.role === EVERYONE ? !isOutsider(who) : who.roles.includes(entry.role));

/**
 * How far someone reaches into everything in a place with this list: `edit`, `view`, or null. Add entries
 * give nothing here (`canAddIn`). Someone outside never gets Edit, even from a list that somehow says so.
 */
export function levelIn(who: Access, list: readonly AccessEntry[] | undefined): ReadLevel | null {
	if (who.owner) return "edit";
	let level: ReadLevel | null = null;
	for (const entry of list ?? OPEN_ACCESS) {
		if (!isFor(who, entry)) continue;
		if (entry.level === "edit" && !isOutsider(who)) return "edit";
		if (entry.level === "view") level = "view";
	}
	return level;
}

/** Whether someone may add records to a database with this list (and see, change or archive the ones they made): Edit, or Add. */
export const canAddIn = (who: Access, list: readonly AccessEntry[] | undefined) =>
	levelIn(who, list) === "edit" || (list ?? OPEN_ACCESS).some((e) => e.level === "add" && isFor(who, e));

/** Whether someone reaches a place at all: View, Edit or Add. */
export const anyAccessIn = (who: Access, list: readonly AccessEntry[] | undefined) => !!levelIn(who, list) || canAddIn(who, list);

/** Whether `level` is enough for `need` across the whole place. Add needs `canAddIn`. */
export const reaches = (level: AccessLevel | null, need: AccessLevel) => level === "edit" || (level === "view" && need === "view");

/** The level the list gives Public, or null if it isn't shared outside. */
export const publicLevel = (list: readonly AccessEntry[] | undefined): AccessLevel | null => list?.find((e) => e.role === PUBLIC)?.level ?? null;

/** Whether a list is anything but the default for members, so the sidebar shows a lock. Sharing with Public shows its own sign (`publicLevel`). */
export const isRestricted = (list: readonly AccessEntry[] | undefined) => {
	const members = list?.filter((e) => e.role !== PUBLIC);
	return !!members && !(members.length === 1 && members[0]!.role === EVERYONE && members[0]!.level === "edit");
};

/** Whether a list is exactly the default (Everyone at Edit, nobody outside), so it's stored as no list. */
export const isOpen = (list: readonly AccessEntry[] | undefined) => !list || (list.length === 1 && list[0]!.role === EVERYONE && list[0]!.level === "edit");

type RoleLike = { id: string; name: string; owner: boolean };

/**
 * The roles that reach `need` in a place, by name, Owners last: "Office and Owners". Everyone on
 * the list at that level reads as "everyone". Roles that no longer exist are skipped.
 */
export function whoCan(list: readonly AccessEntry[] | undefined, roles: readonly RoleLike[], need: AccessLevel = "view"): string {
	// Public is named only to those who ask what's shared outside; members ask a role on the team.
	const entries = (list ?? OPEN_ACCESS).filter((e) => e.role !== PUBLIC && (e.level === "edit" || e.level === need));
	if (entries.some((e) => e.role === EVERYONE)) return "Everyone";
	const names = roles.filter((r) => !r.owner && entries.some((e) => e.role === r.id)).map((r) => r.name);
	return names.length ? `${names.join(", ")} and Owners` : "Owners";
}

const verbs: Record<PlaceKind, Record<AccessLevel, string>> = {
	channel: { view: "see", add: "post in", edit: "post in" },
	database: { view: "see", add: "add to", edit: "change" },
	page: { view: "see", add: "edit", edit: "edit" },
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
 * A list as saved: roles in the workspace (`roleIds`), Everyone or Public, each once, at most one level each.
 * Add is for databases only, and Public never goes past its ceiling (`publicLevelProblem`): never Edit,
 * never a channel. Owners always have Edit, so naming the Owner role adds nothing and is dropped.
 * Throws a plain message.
 */
export function cleanAccess(list: readonly AccessEntry[], roleIds: readonly string[], ownerRoleId: string, kind: PlaceKind): AccessEntry[] {
	const seen = new Set<string>();
	const out: AccessEntry[] = [];
	for (const entry of list) {
		if (entry.role !== EVERYONE && entry.role !== PUBLIC && !roleIds.includes(entry.role)) throw new Error("Role not found.");
		if (!accessLevels.includes(entry.level)) throw new Error("Pick View or Edit.");
		if (entry.level === "add" && kind !== "database") throw new Error("Add is only for databases.");
		const problem = entry.role === PUBLIC && publicLevelProblem(kind, entry.level);
		if (problem) throw new Error(problem);
		if (entry.role === ownerRoleId || seen.has(entry.role)) continue;
		seen.add(entry.role);
		out.push({ role: entry.role, level: entry.level });
	}
	return out;
}

/**
 * Whether `next` lets anyone further in than `before`: someone in no role, in any one role, or outside
 * (Public), reaches more: View, Add or Edit they didn't have. Someone's reach is the union of what their
 * roles give, so checking roles one at a time covers every mix of them.
 */
export function widens(before: readonly AccessEntry[] | undefined, next: readonly AccessEntry[] | undefined, roleIds: readonly string[]) {
	const can = (who: Access, list: readonly AccessEntry[] | undefined) => [!!levelIn(who, list), canAddIn(who, list), levelIn(who, list) === "edit"];
	return [[], [PUBLIC], ...roleIds.map((id) => [id])].some((roles) => {
		const who = { roles, owner: false, permissions: [] };
		const was = can(who, before);
		return can(who, next).some((has, i) => has && !was[i]);
	});
}
