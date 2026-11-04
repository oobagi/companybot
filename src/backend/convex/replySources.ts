import { EVERYONE, whoCan } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, memberOf } from "./lib";
import { chatAccess, reach, type AccessList } from "./placeAccess";
import { canReadSources, source } from "./replyPrivacy";

type Place = Id<"recordTypes"> | Id<"pages"> | Id<"chats">;
export type UsedPlace = Place | Id<"users">;
const writes = new WeakMap<Member, Promise<void>>();

/** Reads in a turn are mutations: the source commits before its result can reach the model or stream. */
export async function notePlace(ctx: QueryCtx, member: Member, id: Place, access: AccessList, privateChannel = false) {
	if (!member.replyId) return;

	const place = await ctx.db.get(id);
	const restricted = privateChannel || access && !access.some((e) => e.role === EVERYONE);
	await inheritPlaces(ctx, member, [...(restricted ? [id] : []), ...(place?.usedPlaces ?? [])]);
}

/** Reading a private reply also carries its sources into the reply being written. */
export async function inheritPlaces(ctx: QueryCtx, member: Member, sources: UsedPlace[] = []) {
	if (!member.replyId || !sources.length) return;
	if (!("patch" in ctx.db)) throw new Error("Agent source reads must run in a mutation.");
	const next = (writes.get(member) ?? Promise.resolve()).then(async () => {
		const reply = await ctx.db.get(member.replyId!);
		if (!reply) throw new Error("Reply no longer exists.");
		const usedPlaces = [...new Set([...(reply.usedPlaces ?? []), ...sources])];
		if (usedPlaces.length !== reply.usedPlaces?.length) await (ctx as MutationCtx).db.patch(reply._id, { usedPlaces });
	});
	writes.set(member, next);
	await next;
}

/** Complete provenance, even before context has loaded the origin chat. */
export async function turnSources(ctx: QueryCtx, member: Member): Promise<UsedPlace[]> {
	const reply = member.replyId && await ctx.db.get(member.replyId);
	if (!reply) return [];
	const origin = await ctx.db.get(reply.chatId);
	return [...new Set([...(reply.usedPlaces ?? []), ...(origin ? chatSources(origin) : [])])];
}

/** Event copies and ordinary turns use the same chat provenance. */
export function chatSources(chat: Doc<"chats">): UsedPlace[] {
	const access = chatAccess(chat);
	const restricted = chat.kind !== "channel" || chat.private || access && !access.some((e) => e.role === EVERYONE);
	return [...new Set([...(restricted ? [chat._id] : []), ...(chat.usedPlaces ?? [])])];
}

export type Sourced = { usedPlaces?: UsedPlace[] };
export type Audience = Place | { access?: AccessList; users?: Id<"users">[] } | { places: UsedPlace[] } | { filtered: true };

/** The same provenance applies when an artifact is read by a turn or copied into a scheduled trigger. */
export const artifactSources = (artifact: Sourced, personalTo?: Id<"users"> | null): UsedPlace[] => [...new Set([...(artifact.usedPlaces ?? []), ...(personalTo ? [personalTo] : [])])];

/** A private artifact has the same read rule as a reply, and passes on everything it used. */
export async function readArtifact(ctx: QueryCtx, member: Member, artifact: Sourced, personalTo?: Id<"users"> | null) {
	const sources = artifactSources(artifact, personalTo);
	if (!(await canReadSources(ctx, member, sources))) return false;
	await inheritPlaces(ctx, member, sources);
	return true;
}

/**
 * The single write rule: the destination's audience must be able to open every source.
 * Private artifacts retain that provenance so a later turn or audience change cannot wash it away.
 * Chat messages use their recorded sources to narrow the audience at read time instead.
 */
export async function writeSources(ctx: MutationCtx, member: Member, audience?: Audience, artifact: Sourced = {}): Promise<UsedPlace[]> {
	const place = typeof audience === "string" ? await ctx.db.get(audience) : null;
	const usedPlaces = [...new Set([...(artifact.usedPlaces ?? []), ...(place?.usedPlaces ?? []), ...await turnSources(ctx, member)])];
	if (audience && typeof audience === "object" && "filtered" in audience) return usedPlaces;
	const policies = typeof audience === "string" ? [await source(ctx, member, audience, true)] : audience && "places" in audience ? await Promise.all(audience.places.map((id) => source(ctx, member, id, true))) : [audience];
	const memberships = policies.flatMap((p) => p?.users ? [p.users] : []);
	const users = memberships[0]?.filter((id) => memberships.every((list) => list.includes(id)));
	for (const id of usedPlaces) {
		if (id === audience) continue;
		const from = await source(ctx, member, id);
		let allowed = true;
		if (audience && typeof audience === "object" && "places" in audience && audience.places.includes(id)) continue;
		else if (users) {
			for (const userId of users) {
				const viewer = await memberOf(ctx, userId, member.workspaceId);
				if (!viewer || !(await canReadSources(ctx, viewer, [id]))) { allowed = false; break; }
			}
		} else {
			// The largest set of roles that cannot read this source is a counterexample if it
			// can read the destination. This also covers intersections across several places.
			const roles = member.workspaceRoles.filter((r) => !r.owner && !reach({ ...member, owner: false, roles: [r.id] }, from.access)).map((r) => r.id);
			const viewer = { ...member, owner: false, roles };
			allowed = !from.membersOnly && (!policies.every((p) => !!reach(viewer, p?.access)) || !!reach(viewer, from.access));
		}
		if (!allowed || !from.visible) {
			const who = from.person ?? (from.membersOnly ? `${whoCan(from.access, member.workspaceRoles) === "Everyone" ? "people" : whoCan(from.access, member.workspaceRoles)} in ${from.where}` : whoCan(from.access, member.workspaceRoles));
			throw new ConvexError(`This reply uses restricted places. Only ${who} can see this. It can't save it for a wider audience.`);
		}
	}
	if (place && usedPlaces.some((id) => id !== place._id)) {
		await ctx.db.patch(place._id, { usedPlaces: usedPlaces.filter((id) => id !== place._id) });
	}
	return usedPlaces;
}
