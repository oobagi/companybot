import { type AccessEntry, type AccessLevel, type PlaceKind, EVERYONE, cleanAccess, isRestricted, levelIn, placeDeniedMessage, reaches, whoCan } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { type Member, rolesOf } from "./lib";

// Who can access each channel, database and page (core place-access.ts). Every read and write of a
// place goes through `reach` or `requireAccess`, so app and agent tools (acting as their person)
// follow the same list. See wiki/permissions.md#who-can-access.
/** A place's stored list: unset is Everyone at Edit (a page's: its parent's). */
export type AccessList = { role: Id<"roles"> | typeof EVERYONE; level: AccessLevel }[] | undefined;

/** How far someone reaches in a place with this list: "edit", "view" or null. */
export const reach = (member: Member, list: AccessList) => levelIn(member, list);

/**
 * Refuses someone without `need` in a place, naming who has it: "Only Office and Owners can see
 * Deals." Agents get this line as their tool result, so they can tell their person whom to ask.
 * The place's own name only goes to someone who can see it; anyone else gets back just what they
 * asked by (`asked`, the name they typed), or "this page" when they asked by id.
 */
export function requireAccess(member: Member, kind: PlaceKind, name: string, list: AccessList, need: AccessLevel, asked?: string) {
	const level = reach(member, list);
	if (!reaches(level, need)) throw new ConvexError(placeDeniedMessage(kind, level ? name : (asked ?? `this ${kind}`), list, member.workspaceRoles, need));
}

/** A channel's list. DMs and side chats are their members' alone, so they have none. */
export const chatAccess = (chat: Doc<"chats">): AccessList => (chat.kind === "channel" ? chat.access : undefined);

/** How a channel reads in a refusal. */
export const channelName = (chat: Doc<"chats">) => `#${chat.name ?? "channel"}`;

/** What the app shows about a place's list: who's on it and whether it's restricted, for the lock and its tooltip. */
export function accessInfo(member: Member, list: AccessList) {
	// Preserve an empty restricted list while hiding roles already deleted, before cleanup runs.
	list = list?.filter((e) => e.role === EVERYONE || member.workspaceRoles.some((r) => r.id === e.role));
	return {
		access: (list ?? [{ role: EVERYONE, level: "edit" as const }]).map((e) => ({ role: e.role as string, level: e.level })),
		restricted: isRestricted(list),
		/** Who can see it ("Office and Owners"), or for one everyone sees but few change, who can. */
		lock: !isRestricted(list) ? null : whoCan(list, member.workspaceRoles, "view") === "Everyone" ? { who: whoCan(list, member.workspaceRoles, "edit"), edit: true } : { who: whoCan(list, member.workspaceRoles, "view"), edit: false },
		level: reach(member, list),
	};
}

/**
 * A list as saved, from this workspace's roles only: an id from elsewhere (or a deleted role) is
 * refused, and the Owner role is dropped since owners always have Edit.
 */
export async function savedAccess(ctx: QueryCtx, member: Member, list: AccessEntry[]): Promise<NonNullable<AccessList>> {
	const roles = await rolesOf(ctx, member.workspaceId);
	try {
		return cleanAccess(list, roles.map((r) => r._id), roles.find((r) => r.builtIn === "owner")?._id ?? "") as NonNullable<AccessList>;
	} catch (e) {
		throw new ConvexError((e as Error).message);
	}
}

/** The list without a deleted role, for roles.remove. Emptied, it's Owners only, as before. */
export const withoutRole = (list: NonNullable<AccessList>, roleId: Id<"roles">) => list.filter((e) => e.role !== roleId);
