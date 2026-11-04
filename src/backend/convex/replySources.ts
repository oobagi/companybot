import { EVERYONE } from "@companybot/core";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Member } from "./lib";
import type { AccessList } from "./placeAccess";

export type UsedPlace = Id<"recordTypes"> | Id<"pages"> | Id<"chats">;
const writes = new WeakMap<Member, Promise<void>>();

/** Reads in a turn are mutations: the source commits before its result can reach the model or stream. */
export async function notePlace(ctx: QueryCtx, member: Member, id: UsedPlace, access: AccessList, privateChannel = false) {
	if (!member.replyId || (!privateChannel && (!access || access.some((e) => e.role === EVERYONE)))) return;
	// Reading the destination DM adds no restriction: its audience already is its participants.
	if (privateChannel && ctx.db.normalizeId("chats", id)) {
		const chat = await ctx.db.get(id as Id<"chats">);
		if (chat?.kind === "dm" && (await ctx.db.get(member.replyId))?.chatId === id) return;
	}
	await inheritPlaces(ctx, member, [id]);
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

export async function turnSources(ctx: QueryCtx, member: Member): Promise<NonNullable<Doc<"chatMessages">["usedPlaces"]>> {
	return member.replyId ? ((await ctx.db.get(member.replyId))?.usedPlaces ?? []) : [];
}
