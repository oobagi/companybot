import { EVERYONE } from "@companybot/core";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Member } from "./lib";
import type { AccessList } from "./placeAccess";

export type UsedPlace = Id<"recordTypes"> | Id<"pages"> | Id<"chats">;
const writes = new WeakMap<Member, Promise<void>>();

/** Reads in a turn are mutations: the source commits before its result can reach the model or stream. */
export async function notePlace(ctx: QueryCtx, member: Member, id: UsedPlace, access: AccessList, privateChannel = false) {
	if (!member.replyId || (!privateChannel && (!access || access.some((e) => e.role === EVERYONE)))) return;
	// The destination's readers already share that audience, for every kind of chat.
	if ((await ctx.db.get(member.replyId))?.chatId === id) return;
	await inheritPlaces(ctx, member, [id]);
}

/** Reading a private reply also carries its sources into the reply being written. */
export async function inheritPlaces(ctx: QueryCtx, member: Member, sources: UsedPlace[] = []) {
	if (!member.replyId || !sources.length) return;
	if (!("patch" in ctx.db)) throw new Error("Agent source reads must run in a mutation.");
	const next = (writes.get(member) ?? Promise.resolve()).then(async () => {
		const reply = await ctx.db.get(member.replyId!);
		if (!reply) throw new Error("Reply no longer exists.");
		const usedPlaces = [...new Set([...(reply.usedPlaces ?? []), ...sources].filter((id) => id !== reply.chatId))];
		if (usedPlaces.length !== reply.usedPlaces?.length) await (ctx as MutationCtx).db.patch(reply._id, { usedPlaces });
	});
	writes.set(member, next);
	await next;
}

export async function turnSources(ctx: QueryCtx, member: Member): Promise<NonNullable<Doc<"chatMessages">["usedPlaces"]>> {
	return member.replyId ? ((await ctx.db.get(member.replyId))?.usedPlaces ?? []) : [];
}

/** Shared instructions would carry private facts outside the reply's audience. */
export async function requireUnrestrictedTurn(ctx: QueryCtx, member: Member) {
	if ((await turnSources(ctx, member)).length) throw new ConvexError("This reply uses restricted places. It can't save shared instructions.");
}
