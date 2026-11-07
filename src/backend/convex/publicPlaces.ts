import { NAME_KEY, PUBLIC_ACCESS, PAGE_READ_MAX, canAddIn, displayValues, levelIn } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { type Outsider, asToolResult, liveWorkspace } from "./lib";
import { pageTitlesFor, readDoc } from "./pageOps";
import { pageStates } from "./pageTree";
import { addableFor, archiveRecordFor, createRecordFor, fieldsOf, outsiderFields, ownRecordFor, toField, typesOf, updateRecordFor } from "./recordOps";
import { listRecords } from "./recordReads";

// What an agent may read and change for someone outside the workspace (an Inbox contact), as the Public
// role. Nothing here is Public-specific but the reader: each page's and database's Who can access list
// decides, through the same rules as members (core place-access.ts, with PUBLIC_ACCESS as the reader):
// - Pages shared with Public at View, and the sub-pages that follow their list (as for members). A sub-page
//   with its own list stays hidden unless that list shares it too. Page blocks name only pages Public can see.
// - Databases shared at View: their records' plain fields. At Add: the records this contact made, which they
//   may also add to, change and archive (cancel).
// - Never record bodies, teammates or links (they'd show other records' and people's names), and never a
//   place holding facts from a restricted source (`usedPlaces`).
// Every call starts from the conversation (`outsiderOf`), rechecked as of now. wiki/permissions.md#public.

/** Pages a list or search looks at, at most: a list is bounded work whatever the workspace holds. */
const PAGES_SCAN = 200;
const PAGES_SHOWN = 50;
const RECORDS_SHOWN = 20;

/** Who an agent is acting for in this conversation, or null if it shouldn't act (staff took it, the agent or workspace went). */
export async function outsiderOf(ctx: QueryCtx, conversationId: Id<"inboxConversations">): Promise<Outsider | null> {
	const c = await ctx.db.get(conversationId);
	if (!c || c.mode !== "agent" || !(await liveWorkspace(ctx, c.workspaceId))) return null;
	const agent = await ctx.db.get(c.agentId);
	if (!agent || agent.archived) return null;
	// Replies only ever go to their real address, so a forged sender reads nothing; changes wait for one that checks out.
	const recent = await ctx.db.query("inboxMessages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).order("desc").take(20);
	const latest = recent.find((m) => m.direction === "in");
	return { workspaceId: c.workspaceId, contact: c.contact, agentId: agent._id, verified: !latest?.unverified };
}

/** Whether Public may read this standalone page: its list (its own or the one it follows) shares it at View. */
export function publicPageVisible(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const state = pageStates(ctx);
	return async (page: Doc<"pages">) => {
		if (page.workspaceId !== workspaceId || page.recordId || page.usedPlaces?.length) return false;
		const { archived, access, ancestors } = await state(page);
		// A page that follows a parent holding restricted facts follows those facts too.
		if (archived || ancestors.some((a) => a.usedPlaces?.length)) return false;
		return levelIn(PUBLIC_ACCESS, access) === "view";
	};
}

/** What Public may do in a database: see every record (View), add and see only their own (Add), or nothing. */
export const publicDatabaseLevel = (type: Doc<"recordTypes">): "view" | "add" | null =>
	type.archived || type.usedPlaces?.length ? null : levelIn(PUBLIC_ACCESS, type.access) === "view" ? "view" : canAddIn(PUBLIC_ACCESS, type.access) ? "add" : null;

/** The fields someone outside sees and fills: plain ones only. */
const fieldsFor = async (ctx: QueryCtx, typeId: Id<"recordTypes">) => outsiderFields(await fieldsOf(ctx, typeId));

/** A record as someone outside reads it: its plain fields' values, as people read them. */
function recordOut(record: Doc<"records">, fields: Doc<"recordFields">[]) {
	return { id: record._id, ...displayValues(fields.map(toField), Object.fromEntries(Object.entries(record.values).filter(([k]) => fields.some((f) => f.key === k)))) };
}

/** Values by field key or label (as `shared` lists them) → by key. A field they can't fill is refused (recordOps checks again). */
function byKey(fields: Doc<"recordFields">[], values: Record<string, unknown>) {
	const out: Record<string, unknown> = {};
	for (const [name, raw] of Object.entries(values)) {
		const n = name.trim().toLowerCase();
		const field = fields.find((f) => f.key === name.trim()) ?? fields.find((f) => f.label.toLowerCase() === n);
		if (!field) throw new ConvexError(`There's no field “${name}” you can fill. Use shared to see the fields.`);
		out[field.key] = raw;
	}
	return out;
}

/** A database someone outside can see or add to, by key, id or name. Others look like they don't exist. */
async function databaseFor(ctx: QueryCtx, by: Outsider, name: string) {
	const n = name.trim().toLowerCase();
	const type = (await typesOf(ctx, by.workspaceId)).find((t) => publicDatabaseLevel(t) && (t._id === name.trim() || t.key === n || t.name.toLowerCase() === n || t.plural.toLowerCase() === n));
	if (!type) throw new ConvexError(`There's no database “${name}” shared with customers. Use shared to see what is.`);
	return { type, level: publicDatabaseLevel(type)! };
}

/** Whether anything is shared with Public at all: decides which tools a reply gets. */
export async function sharedSummary(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const levels = (await typesOf(ctx, workspaceId)).map(publicDatabaseLevel);
	const seen = publicPageVisible(ctx, workspaceId);
	let pages = false;
	for (const p of await ctx.db.query("pages").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("recordId", undefined).eq("archived", false)).take(PAGES_SCAN))
		if (await seen(p)) {
			pages = true;
			break;
		}
	return { pages, view: levels.includes("view"), add: levels.includes("add") };
}

const run = (fn: (by: Outsider) => Promise<unknown>) => async (ctx: QueryCtx, conversationId: Id<"inboxConversations">) => {
	const by = await outsiderOf(ctx, conversationId);
	if (!by) return { error: "Someone on staff has this conversation now. Stop." };
	return asToolResult(() => fn(by));
};

/** What's shared with customers: pages (by title, or matching `search`) and databases with what they may do in each. */
export const shared = internalQuery({
	args: { conversationId: v.id("inboxConversations"), search: v.optional(v.string()) },
	handler: (ctx, { conversationId, search }) =>
		run(async (by) => {
			const seen = publicPageVisible(ctx, by.workspaceId);
			const candidates = search?.trim()
				? await ctx.db.query("pages").withSearchIndex("search_title", (q) => q.search("title", search).eq("workspaceId", by.workspaceId).eq("archived", false)).take(PAGES_SCAN)
				: await ctx.db.query("pages").withIndex("by_workspace", (q) => q.eq("workspaceId", by.workspaceId).eq("recordId", undefined).eq("archived", false)).take(PAGES_SCAN);
			const pages = [];
			for (const p of candidates) if (pages.length < PAGES_SHOWN && (await seen(p))) pages.push({ id: p._id, title: p.title });
			const databases = [];
			for (const t of await typesOf(ctx, by.workspaceId)) {
				const level = publicDatabaseLevel(t);
				if (!level) continue;
				const fields = await fieldsFor(ctx, t._id);
				databases.push({
					database: t.key,
					name: t.plural,
					can: level === "view" ? "see every record" : "add records, and see and change only the ones this customer made",
					fields: fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, ...(f.options && { options: f.options.filter((o) => !o.retired).map((o) => o.label) }), ...(f.key === NAME_KEY && { required: true }) })),
				});
			}
			return { pages, databases };
		})(ctx, conversationId),
});

/** One shared page: its content (ProseMirror JSON, page blocks titled for Public) and its shared sub-pages. */
export const pageFor = internalQuery({
	args: { conversationId: v.id("inboxConversations"), page: v.string() },
	handler: (ctx, { conversationId, page: raw }) =>
		run(async (by) => {
			const id = ctx.db.normalizeId("pages", raw.trim());
			const page = id && (await ctx.db.get(id));
			const seen = publicPageVisible(ctx, by.workspaceId);
			if (!page || !(await seen(page))) throw new ConvexError("Page not found. Use shared to see the pages you can read.");
			const children = [];
			for (const p of await ctx.db.query("pages").withIndex("by_parent", (q) => q.eq("workspaceId", by.workspaceId).eq("parentId", page._id).eq("recordId", undefined).eq("archived", false)).take(PAGES_SCAN))
				if (children.length < PAGES_SHOWN && (await seen(p))) children.push({ id: p._id, title: p.title });
			const doc = await pageTitlesFor(ctx, by.workspaceId, seen, JSON.stringify((await readDoc(ctx, page._id)).toJSON()));
			return { id: page._id, title: page.title, doc, subpages: children };
		})(ctx, conversationId),
});

/** A shared page as Markdown, 20,000 characters at a time. Conversion runs in Node (pageMarkdown.ts). */
export const readPage = internalAction({
	args: { conversationId: v.id("inboxConversations"), page: v.string(), start: v.optional(v.number()) },
	handler: async (ctx, { conversationId, page, start = 0 }): Promise<unknown> => {
		const found = (await ctx.runQuery(internal.publicPlaces.pageFor, { conversationId, page })) as { error: string } | { id: string; title: string; doc: string; subpages: { id: string; title: string }[] };
		if ("error" in found) return found;
		const markdown: string = await ctx.runAction(internal.pageMarkdown.toMarkdown, { doc: found.doc });
		const end = start + PAGE_READ_MAX;
		return { id: found.id, title: found.title, markdown: markdown.slice(start, end), subpages: found.subpages, ...(markdown.length > end && { more: true, next: end }) };
	},
});

/** Records in a shared database: every one at View (newest first, or matching `search`), only this customer's at Add. */
export const findRecords = internalQuery({
	args: { conversationId: v.id("inboxConversations"), database: v.string(), search: v.optional(v.string()), cursor: v.optional(v.string()) },
	handler: (ctx, { conversationId, database, search, cursor }) =>
		run(async (by) => {
			const { type, level } = await databaseFor(ctx, by, database);
			const fields = await fieldsFor(ctx, type._id);
			if (search?.trim() && level === "view") {
				const found = await ctx.db
					.query("records")
					.withSearchIndex("search", (q) => q.search("searchText", search).eq("workspaceId", by.workspaceId).eq("typeId", type._id).eq("archived", false))
					.take(RECORDS_SHOWN);
				return { database: type.key, records: found.map((r) => recordOut(r, fields)) };
			}
			const all = await fieldsOf(ctx, type._id);
			const result = await listRecords(ctx, by.workspaceId, { typeId: type._id, fields: all }, {
				archived: false,
				conditions: [],
				...(level === "add" && { owner: { contact: by.contact } }),
				paginationOpts: { numItems: RECORDS_SHOWN, cursor: cursor ?? null },
			});
			return { database: type.key, ...(level === "add" && { only: "this customer's own records" }), records: result.page.map((r) => recordOut(r, fields)), ...(!result.isDone && { more: true, cursor: result.continueCursor }) };
		})(ctx, conversationId),
});

/**
 * Adds a record for this customer (Add), changes one they made, or archives it (`cancel`). Values go by field
 * key or label, as people read them; only plain fields. Activity names the agent and the customer's address.
 */
export const saveRecord = internalMutation({
	args: { conversationId: v.id("inboxConversations"), database: v.optional(v.string()), record: v.optional(v.string()), values: v.optional(v.record(v.string(), v.any())), cancel: v.optional(v.boolean()) },
	handler: async (ctx, { conversationId, database, record: recordRaw, values, cancel }) => {
		const by = await outsiderOf(ctx, conversationId);
		if (!by) return { error: "Someone on staff has this conversation now. Stop." };
		return asToolResult(async () => {
			const recordId = recordRaw && ctx.db.normalizeId("records", recordRaw.trim());
			if (recordRaw && !recordId) throw new ConvexError("Record not found. Use find_records for this customer's records and their ids.");
			const existing = recordId ? await ownRecordFor(ctx, by, recordId) : null;
			const typeId = existing?.typeId ?? (database ? (await databaseFor(ctx, by, database)).type._id : null);
			if (!typeId) throw new ConvexError("Say which database (database), or which of their records (record).");
			await addableFor(ctx, by, typeId);
			const fields = await fieldsFor(ctx, typeId);
			const input = byKey(fields, values ?? {});
			if (cancel) {
				if (!existing) throw new ConvexError("Say which of their records to cancel (record).");
				if (values && Object.keys(values).length) throw new ConvexError("Cancel on its own, or change values.");
				await archiveRecordFor(ctx, by, existing._id);
				return { cancelled: existing._id };
			}
			if (existing) {
				await updateRecordFor(ctx, by, existing._id, input);
				return recordOut((await ctx.db.get(existing._id))!, fields);
			}
			const { id } = await createRecordFor(ctx, by, typeId, input);
			return recordOut((await ctx.db.get(id))!, fields);
		});
	},
});
