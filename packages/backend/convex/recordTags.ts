import { DELETED_RECORD, PRIVATE_RECORD, recordTag, showRecordTags, storeRecordTags, taggedRecordIds } from "@companybot/core/record-mentions";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { type Member, memo } from "./lib";
import { typeTrashed, typeVisible, workspaceRecords } from "./recordOps";

// Records tagged in chat messages (core record-mentions.ts): stored as ids, read per reader. People read
// `@Name` (or "@Private record" off a database they can't see) and the app makes those chips from `records`;
// agents read `[@Name](record:id)`, the form they write. See wiki/chat.md, "Record tags".

/** One tag as a reader sees it. `text` is how it reads in the message; locked and deleted ones have no id. */
export type RecordTagView = {
	text: string;
	id: Id<"records"> | null;
	typeKey: string | null;
	state: "live" | "archived" | "locked" | "deleted";
};

/**
 * How tags read for one reader, each record looked up once per call. Agents' readers carry the turn's reply
 * (`replyId`), so a name from a database the turn's person reaches only by role counts as one of its sources.
 */
export function recordTags(ctx: QueryCtx, member: Member) {
	const visible = typeVisible(ctx, member);
	const trashed = typeTrashed(ctx);
	const look = memo(async (raw: string): Promise<(RecordTagView & { name: string }) | null> => {
		const id = ctx.db.normalizeId("records", raw);
		const record = id && (await ctx.db.get(id));
		if (!id) return null;
		if (!record) return { text: `@${DELETED_RECORD}`, name: DELETED_RECORD, id: null, typeKey: null, state: "deleted" };
		if (record.workspaceId !== member.workspaceId) return null;
		if (!(await visible(record.typeId))) return { text: `@${PRIVATE_RECORD}`, name: "", id: null, typeKey: null, state: "locked" };
		const type = await ctx.db.get(record.typeId);
		const archived = record.archived || (await trashed(record.typeId));
		return { text: `@${record.title}`, name: record.title, id, typeKey: type?.key ?? null, state: archived ? "archived" : "live" };
	});

	/** Fills in each tag; ones that can't be read go back to their writer's words (a stored one: "a record"). */
	async function fill(text: string, as: (tag: RecordTagView & { name: string }) => string) {
		if (!text.includes("record:")) return text;
		const found = new Map<string, Awaited<ReturnType<typeof look>>>();
		for (const id of taggedRecordIds(text)) found.set(id, await look(id));
		return showRecordTags(text, (id, label) => {
			const tag = found.get(id);
			return tag ? as(tag) : label ?? "a record";
		});
	}

	return {
		/** For people: the text with `@Name`s, and the tags in it for the app's chips. */
		async forPeople(text: string) {
			const records: RecordTagView[] = [];
			const shown = await fill(text, ({ name: _, ...tag }) => {
				if (!records.some((r) => r.text === tag.text && r.id === tag.id)) records.push(tag);
				return tag.text;
			});
			return { text: shown, records };
		},
		/** For an agent's prompt: tags as it writes them, so it can tag the same record back. */
		forModel: (text: string) => fill(text, (tag) => (tag.state === "locked" ? "a private record" : tag.state === "deleted" ? "a deleted record" : recordTag(tag.id!, tag.name))),
	};
}

export type RecordTags = ReturnType<typeof recordTags>;

/** A message's text and its text parts for people, plus the tags in them. */
export async function messageForPeople(tags: RecordTags, m: Pick<Doc<"chatMessages">, "text" | "parts">) {
	const { text, records } = await tags.forPeople(m.text);
	const parts = await Promise.all(
		m.parts.map(async (p) => {
			if (p.type !== "text" || !p.text.includes("record:")) return p;
			const shown = await tags.forPeople(p.text);
			for (const r of shown.records) if (!records.some((x) => x.text === r.text && x.id === r.id)) records.push(r);
			return { ...p, text: shown.text };
		}),
	);
	return { text, parts, records };
}

/**
 * The text to store, and the records it tags that the writer can see (plus `also`, records named by id
 * alone: the API's `mentions.recordIds`). Tags of ones they can't see, or made up, are left as the names they wrote.
 */
export async function storeTags(ctx: QueryCtx, member: Member, text: string, { also = [], kept: before = [] }: { also?: Id<"records">[]; kept?: Id<"records">[] } = {}) {
	const ids = taggedRecordIds(text).flatMap((raw) => ctx.db.normalizeId("records", raw) ?? []);
	const seen = { ...member, replyId: undefined };
	// `kept`: tagged before an edit. They stay, even if the writer can no longer see them: keeping a tag reveals nothing.
	const valid = new Set<string>([...(await workspaceRecords(ctx, seen, ids)), ...before.filter((id) => ids.includes(id))]);
	const stored = storeRecordTags(text, (id) => valid.has(id));
	const kept = taggedRecordIds(stored) as Id<"records">[];
	const extra = (await workspaceRecords(ctx, seen, also)).filter((id) => !kept.includes(id));
	return { text: stored, recordIds: [...kept, ...extra] };
}

/** Brings a message's `recordMentions` rows in line with the records it tags now. */
export async function syncRecordMentions(ctx: MutationCtx, message: Pick<Doc<"chatMessages">, "_id" | "chatId">, recordIds: Id<"records">[]) {
	const rows = await ctx.db
		.query("recordMentions")
		.withIndex("by_message", (q) => q.eq("messageId", message._id))
		.take(100);
	const want = new Set(recordIds);
	for (const row of rows) if (!want.delete(row.recordId)) await ctx.db.delete(row._id);
	for (const recordId of want) await ctx.db.insert("recordMentions", { recordId, messageId: message._id, chatId: message.chatId });
}
