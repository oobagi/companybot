import { type AccessEntry, type AccessLevel, type PlaceKind, EVERYONE, PUBLIC, canAddIn, cleanAccess, isRestricted, levelIn, losesOwnEdit, ownEditMessage, placeDeniedMessage, publicLevel, reaches, whoCan } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { type Member, rolesOf } from "./lib";

// Who can access each channel, database and page (core place-access.ts). Every read and write of a
// place goes through `reach` or `requireAccess`, so app and agent tools (acting as their person)
// follow the same list. See wiki/permissions.md#who-can-access.
/** A place's stored list: unset is Everyone at Edit (a page's: its parent's). */
export type AccessList = { role: Id<"roles"> | typeof EVERYONE | typeof PUBLIC; level: AccessLevel }[] | undefined;

/** How far someone reaches into everything in a place with this list: "edit", "view" or null. Add reaches only your own records (`canAdd`). */
export const reach = (member: Member, list: AccessList) => levelIn(member, list);

/** Whether someone may add records to a database with this list, and see and change the ones they made. */
export const canAdd = (member: Member, list: AccessList) => canAddIn(member, list);

/**
 * Refuses someone without `need` in a place, naming who has it: "Only Office and Owners can see
 * Deals." Agents get this line as their tool result, so they can tell their person whom to ask.
 * The place's own name only goes to someone who can see it; anyone else gets back just what they
 * asked by (`asked`, the name they typed), or "this page" when they asked by id.
 */
export function requireAccess(member: Member, kind: PlaceKind, name: string, list: AccessList, need: AccessLevel, asked?: string) {
	const level = reach(member, list);
	if (need === "add" ? canAdd(member, list) : reaches(level, need)) return;
	// Adding: someone who can't see it hears who can see it; else who can add (or, with no Add on the list, change).
	const said = need !== "add" ? need : !level ? "view" : list?.some((e) => e.level === "add") ? "add" : "edit";
	throw new ConvexError(placeDeniedMessage(kind, level ? name : (asked ?? `this ${kind}`), list, member.workspaceRoles, said));
}

/** Refuses a list change that would take the person's own Edit (Post) away; Owners always keep it. */
export function requireKeepsEdit(member: Member, kind: PlaceKind, next: AccessList) {
	if (losesOwnEdit(member, next)) throw new ConvexError(ownEditMessage(kind));
}

/** A channel's list. DMs and side chats are their members' alone, so they have none. */
export const chatAccess = (chat: Doc<"chats">): AccessList => (chat.kind === "channel" ? chat.access : undefined);

/** How a channel reads in a refusal. */
export const channelName = (chat: Doc<"chats">) => `#${chat.name ?? "channel"}`;

/** What the app shows about a place's list: who's on it and whether it's restricted, for the lock and its tooltip. */
export function accessInfo(member: Member, list: AccessList) {
	// Preserve an empty restricted list while hiding roles already deleted, before cleanup runs.
	list = list?.filter((e) => e.role === EVERYONE || e.role === PUBLIC || member.workspaceRoles.some((r) => r.id === e.role));
	return {
		access: (list ?? [{ role: EVERYONE, level: "edit" as const }]).map((e) => ({ role: e.role as string, level: e.level })),
		restricted: isRestricted(list),
		/** Who can see it ("Office and Owners"), or for one everyone sees but few change, who can. */
		lock: !isRestricted(list) ? null : whoCan(list, member.workspaceRoles, "view") === "Everyone" ? { who: whoCan(list, member.workspaceRoles, "edit"), edit: true } : { who: whoCan(list, member.workspaceRoles, "view"), edit: false },
		level: reach(member, list),
		/** Databases: they may add records, and see and change their own, without View (Add). */
		canAdd: canAdd(member, list),
		/** What people outside the workspace may do here, if it's shared with Public. */
		public: publicLevel(list),
	};
}

/**
 * A list as saved, from this workspace's roles only: an id from elsewhere (or a deleted role) is
 * refused, and the Owner role is dropped since owners always have Edit. Add is refused outside a
 * database, and Public past its ceiling (core `publicLevelProblem`): never Edit, never a channel.
 */
export async function savedAccess(ctx: QueryCtx, member: Member, list: AccessEntry[], kind: PlaceKind): Promise<NonNullable<AccessList>> {
	const roles = await rolesOf(ctx, member.workspaceId);
	try {
		return cleanAccess(list, roles.map((r) => r._id), roles.find((r) => r.builtIn === "owner")?._id ?? "", kind) as NonNullable<AccessList>;
	} catch (e) {
		throw new ConvexError((e as Error).message);
	}
}

/** The list without a deleted role, for roles.remove. Emptied, it's Owners only, as before. */
export const withoutRole = (list: NonNullable<AccessList>, roleId: Id<"roles">) => list.filter((e) => e.role !== roleId);
