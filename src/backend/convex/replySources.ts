import { EVERYONE, whoCan } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, accessOf, rolesOf } from "./lib";
import { chatAccess, reach, type AccessList } from "./placeAccess";
import { canReadSources, opensSource, writeSourceReader } from "./replyPrivacy";

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
export type Audience = Place | { place?: Place; access?: AccessList; users?: Id<"users">[] } | { places: UsedPlace[] } | { filtered: true; preserveOwn?: true };

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
 * Only the asker's own turn in their agent DM may publish their one-person data. Every other source must fit the
 * destination audience. The original reply keeps all sources for display and context privacy.
 */
export async function writeSources(ctx: MutationCtx, member: Member, audience?: Audience, artifact: Sourced = {}): Promise<UsedPlace[]> {
	const { usedPlaces, place } = await fitSources(ctx, member, audience, artifact);
	if (place) {
		const saved = usedPlaces.filter((id) => id !== place._id);
		if (saved.length !== (place.usedPlaces?.length ?? 0) || saved.some((id) => !place.usedPlaces?.includes(id))) await ctx.db.patch(place._id, { usedPlaces: saved.length ? saved : undefined });
	}
	return usedPlaces;
}

/**
 * Whether what this turn has read so far is more private than its own chat: someone who can see the chat
 * couldn't see one of its sources (the same rule as `writeSources` with the chat as the audience). Then what
 * it sends outside the workspace (a web search's query, a link it opens) asks first (permissions.check).
 */
export async function turnIsRestricted(ctx: QueryCtx, member: Member, chatId: Id<"chats">) {
	if (!member.replyId) return false;
	try {
		await fitSources(ctx, member, chatId);
		return false;
	} catch (e) {
		if (e instanceof ConvexError) return true;
		throw e;
	}
}

/** `writeSources` without saving anything: the sources a write keeps, or a refusal if they don't fit `audience`. */
async function fitSources(ctx: QueryCtx, member: Member, audience?: Audience, artifact: Sourced = {}) {
	const placeId = typeof audience === "string" ? audience : audience && "place" in audience ? audience.place : undefined;
	const place = placeId ? await ctx.db.get(placeId) : null;
	const all = [...new Set([...(artifact.usedPlaces ?? []), ...(place?.usedPlaces ?? []), ...await turnSources(ctx, member)])];
	if (audience && typeof audience === "object" && "filtered" in audience && audience.preserveOwn) return { usedPlaces: all, place };
	const readSource = writeSourceReader(ctx, member);
	const sources = await Promise.all(all.map(async (id) => ({ id, policy: await readSource(id) })));
	const retained = sources.filter(({ policy }) => !member.ownWrites || !policy.visible || policy.exclusiveTo !== member.userId);
	const usedPlaces = retained.map(({ id }) => id);
	if (audience && typeof audience === "object" && "filtered" in audience) return { usedPlaces, place };
	const policies = typeof audience === "string" ? [await readSource(audience)] : audience && "places" in audience ? await Promise.all(audience.places.map(readSource)) : [audience];
	const memberships = policies.flatMap((p) => p?.users ? [p.users] : []);
	const users = memberships[0]?.filter((id) => memberships.every((list) => list.includes(id)));
	// Load memberships and roles once per write, not once per source and destination member.
	const viewers: Member[] = [];
	if (users && retained.length) {
		const roles = await rolesOf(ctx, member.workspaceId);
		for (const userId of new Set(users)) {
			const row = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId).eq("workspaceId", member.workspaceId)).first();
			if (row) {
				const viewer = { ...member, ...accessOf(roles, row), userId, id: row._id };
				if (policies.every((p) => !p || opensSource(viewer, p))) viewers.push(viewer);
			}
		}
	}
	for (const { id, policy: from } of retained) {
		// The place being changed will use the proposed policy itself. Other sources must still fit.
		if (id === placeId) continue;
		if (audience && typeof audience === "object" && "places" in audience && audience.places.includes(id)) continue;
		let allowed: boolean;
		if (users) allowed = viewers.every((viewer) => opensSource(viewer, from));
		else {
			// The largest role set that cannot open this source is a counterexample if it opens the destination.
			const roles = member.workspaceRoles.filter((r) => !r.owner && !reach({ ...member, owner: false, roles: [r.id] }, from.access)).map((r) => r.id);
			const viewer = { ...member, owner: false, roles };
			allowed = !from.membersOnly && (!policies.every((p) => !!reach(viewer, p?.access)) || !!reach(viewer, from.access));
		}
		if (!allowed || !from.visible) {
			const who = from.person ?? (from.membersOnly ? `${whoCan(from.access, member.workspaceRoles) === "Everyone" ? "people" : whoCan(from.access, member.workspaceRoles)} in ${from.where}` : whoCan(from.access, member.workspaceRoles));
			throw new ConvexError(`This reply uses restricted places. Only ${who} can see this. It can't save it for a wider audience.`);
		}
	}
	return { usedPlaces, place };
}
