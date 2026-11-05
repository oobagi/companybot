import { EVERYONE, whoCan } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, accessOf, rolesOf } from "./lib";
import { chatAccess, reach, type AccessList } from "./placeAccess";
import { canReadSources, opensSource, type Source, writeSourceReader } from "./replyPrivacy";

type Place = Id<"recordTypes"> | Id<"pages"> | Id<"driveFiles"> | Id<"chats">;
export type UsedPlace = Place | Id<"users"> | Id<"connectorInstalls">;
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
export type Audience = Place | { place?: Place; access?: AccessList; users?: Id<"users">[]; settings?: true; skip?: UsedPlace } | { places: UsedPlace[] } | { filtered: true; preserveOwn?: true };

/** The same provenance applies when an artifact is read by a turn or copied into a scheduled trigger. */
export const artifactSources = (artifact: Sourced, personalTo?: Id<"users"> | null): UsedPlace[] => [...new Set([...(artifact.usedPlaces ?? []), ...(personalTo ? [personalTo] : [])])];

/** A private artifact has the same read rule as a reply, and passes on everything it used. */
export async function readArtifact(ctx: QueryCtx, member: Member, artifact: Sourced, personalTo?: Id<"users"> | null) {
	const sources = artifactSources(artifact, personalTo);
	if (!(await canReadSources(ctx, member, sources))) return false;
	await inheritPlaces(ctx, member, sources);
	return true;
}

/** Direct Owner access changes may release deleted installs, only on the place being deliberately re-shared. */
export async function changeAccessSources(ctx: MutationCtx, member: Member, place: Doc<"recordTypes"> | Doc<"chats"> | Doc<"pages"> | Doc<"driveFiles">, audience: { access?: AccessList; users?: Id<"users">[] }) {
	const retained: UsedPlace[] = [];
	for (const id of place.usedPlaces ?? []) {
		if (id === place._id) continue;
		const connector = ctx.db.normalizeId("connectorInstalls", id);
		if (member.owner && !member.replyId && connector && !(await ctx.db.get(connector))) continue;
		retained.push(id);
	}
	const saved = await writeSources(ctx, member, { ...audience, settings: true }, { usedPlaces: retained });
	if (saved.length !== (place.usedPlaces?.length ?? 0) || saved.some((id) => !place.usedPlaces?.includes(id))) {
		await ctx.db.patch(place._id, { usedPlaces: saved.length ? saved : undefined });
	}
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
 * Whether anything this turn has read is restricted: then what it sends outside the workspace (a web search's
 * query, a link it opens, a connector call) asks first (permissions.check). Outside has a wider audience than
 * any chat, so the chat it runs in counts too (a private channel, a group DM), and so does a role-limited
 * connector it read (#234), except for a read-only call to that same connector (`target`). The one exception is #210's
 * own-data rule: in the asker's own 1:1 agent DM, their one-person data (that DM, personal memory, skills and
 * connector data) doesn't count; anyone else's restricted place still does.
 */
export async function turnIsRestricted(ctx: QueryCtx, member: Member, target?: Id<"connectorInstalls">) {
	if (!member.replyId) return false;
	// The same check as a write to a place open to the whole workspace: a source that wouldn't fit it is restricted.
	// Reading more from the workspace connector the data came from (`target`, read-only calls only) stays within its audience.
	try {
		await fitSources(ctx, member, { access: [{ role: EVERYONE, level: "view" }], skip: target });
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
	await (await audienceFit(ctx, member, audience, place, readSource))(retained);
	return { usedPlaces, place };
}

/**
 * Whether content using `sources` could show to everyone in a chat: a reply that couldn't is private there.
 * Built once per place (its policy and members load once), then checked per reply.
 */
export async function placeAudience(ctx: QueryCtx, member: Member, chatId: Id<"chats">) {
	const readSource = writeSourceReader(ctx, member);
	const check = await audienceFit(ctx, member, chatId, await ctx.db.get(chatId), readSource);
	return async (sources: UsedPlace[] = []) => {
		try {
			await check(await Promise.all(sources.map(async (id) => ({ id, policy: await readSource(id) }))));
			return true;
		} catch (e) {
			if (e instanceof ConvexError) return false;
			throw e;
		}
	};
}

/** The destination's audience, loaded once; the returned check refuses any source it can't open. */
async function audienceFit(ctx: QueryCtx, member: Member, audience: Audience | undefined, place: Doc<"recordTypes"> | Doc<"pages"> | Doc<"driveFiles"> | Doc<"chats"> | null, readSource: (id: UsedPlace) => Promise<Source>) {
	const placeId = place?._id;
	const policies = typeof audience === "string" ? [await readSource(audience)] : audience && "places" in audience ? await Promise.all(audience.places.map(readSource)) : [audience && typeof audience === "object" && !("filtered" in audience) ? audience : undefined];
	// Content edits keep the destination's saved sources, which can narrow its audience beyond its access list.
	// Proposed access changes still have to fit every source on their own.
	if (typeof audience === "string") policies.push(...await Promise.all((place?.usedPlaces ?? []).map(readSource)));
	const memberships = policies.flatMap((p) => p?.users ? [p.users] : []);
	const users = memberships[0]?.filter((id) => memberships.every((list) => list.includes(id)));
	// Load memberships and roles once per destination, not once per source and destination member.
	let viewers: Member[] | undefined;
	const loadViewers = async () => {
		const found: Member[] = [];
		const roles = await rolesOf(ctx, member.workspaceId);
		for (const userId of new Set(users)) {
			const row = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId).eq("workspaceId", member.workspaceId)).first();
			if (row) {
				const viewer = { ...member, ...accessOf(roles, row), userId, id: row._id };
				if (policies.every((p) => !p || opensSource(viewer, p))) found.push(viewer);
			}
		}
		return found;
	};
	return async (retained: { id: UsedPlace; policy: Source }[]) => {
		for (const { id, policy: from } of retained) {
			// The place being changed will use the proposed policy itself. Other sources must still fit.
			if (id === placeId) continue;
			if (audience && typeof audience === "object" && "skip" in audience && audience.skip === id) continue;
			if (audience && typeof audience === "object" && "places" in audience && audience.places.includes(id)) continue;
			let allowed: boolean;
			if (users) allowed = (viewers ??= await loadViewers()).every((viewer) => opensSource(viewer, from));
			else {
				// The largest role set that cannot open this source is a counterexample if it opens the destination.
				const roles = member.workspaceRoles.filter((r) => !r.owner && !reach({ ...member, owner: false, roles: [r.id] }, from.access)).map((r) => r.id);
				const viewer = { ...member, owner: false, roles };
				allowed = !from.membersOnly && (!policies.every((p) => !!reach(viewer, p?.access)) || !!reach(viewer, from.access));
			}
			if (!allowed || !from.visible) {
				const who = from.person ?? (from.membersOnly ? `${whoCan(from.access, member.workspaceRoles) === "Everyone" ? "people" : whoCan(from.access, member.workspaceRoles)} in ${from.where}` : whoCan(from.access, member.workspaceRoles));
				if (audience && typeof audience === "object" && "settings" in audience && audience.settings) {
					const name = from.visible || from.deletedConnector ? from.name : "a restricted source";
					throw new ConvexError(`Can't change access: ${name} is restricted. Only ${who} can open this source.${from.deletedConnector ? " An Owner can re-share its saved work after uninstall." : " Choose roles that can open every source."}`);
				}
				throw new ConvexError(`This reply uses restricted places. Only ${who} can see this. It can't save it for a wider audience.`);
			}
		}
	};
}
