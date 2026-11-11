import { integrationOperations, type IntegrationOperation } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";
import { authenticateIntegration, tokenHash } from "./integrationTokens";
import { type Member, checkPermission } from "./lib";
import { requireChat, requireChatToPost, requirePost, canSee, chatLabel, namer } from "./chatOps";
import { readMessages, sendMessage } from "./messages";
import { createRecord, updateRecord, requireType, requireRecord, fieldsOf, fieldsShown, toRows, typeVisible } from "./recordOps";
import { listRecords } from "./recordReads";
import { createPage, readDoc, requirePage, pageVisible, withPageTitles, writeBlocks } from "./pageOps";
import { kindOf, pageState } from "./pageTree";

const DAY = 86400000;
const failure = (status: number, error: string, retryAfter?: number) => ({ status, error, ...(retryAfter !== undefined && { retryAfter }) });
function normalize<T extends TableNames>(ctx: MutationCtx, table: T, value: string): Id<T> {
	const id = ctx.db.normalizeId(table, value);
	if (!id) throw new ConvexError("Invalid resource id.");
	return id;
}
/** Plain text only: callers cannot smuggle page embeds, file URLs, or page links into a write. */
const paragraphs = (text: string) => JSON.stringify(text.split("\n").map(line => ({ type: "blockContainer", attrs: { id: crypto.randomUUID() }, content: [{ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }] })));

/** HTTP and MCP use this one transaction for authentication, permissions, writes and receipts. */
export const dispatch = internalMutation({
	args: { hash: v.string(), operation: v.optional(v.string()), input: v.optional(v.any()) },
	handler: async (ctx, { hash, operation, input }) => {
		const auth = await authenticateIntegration(ctx, hash);
		if (!auth) return failure(401, "Invalid or expired token.");
		const { token, member } = auth;
		const now = Date.now();
		const windowAt = token.windowAt && token.windowAt > now - 60000 ? token.windowAt : now;
		const count = windowAt === token.windowAt ? token.requests ?? 0 : 0;
		if (count >= 60) return failure(429, "Rate limit reached. Try again in one minute.", 60);
		await ctx.db.patch(token._id, { windowAt, requests: count + 1, lastUsedAt: now });
		if (!operation) return { status: 200, data: { scopes: token.scopes } };
		if (!Object.hasOwn(integrationOperations, operation)) return failure(404, "Unknown operation.");
		const name = operation as IntegrationOperation;
		const definition = integrationOperations[name];
		if (!token.scopes.includes(definition.scope)) return failure(403, "Token lacks the required scope.");
		const parsed = definition.input.strict().safeParse(input ?? {});
		if (!parsed.success) return failure(400, "Invalid arguments. Use the operation's published input schema.");
		const args = parsed.data;
		const write = definition.scope.endsWith(":write");
		const receipts = token.receipts.filter(r => r.at > now - DAY);
		const key = (args as { requestKey?: string }).requestKey;
		const fingerprint = await tokenHash(JSON.stringify(args));
		const previous = key ? receipts.find(r => r.key === key) : undefined;
		// Validate current place access even when returning a receipt from a prior success.
		await authorize(ctx, member, name, args);
		if (previous) {
			if (previous.operation !== name || previous.fingerprint !== fingerprint) return failure(409, "This request key was used with different arguments.");
			return { status: 200, data: previous.result };
		}
		if (write && receipts.length >= 128) return failure(429, "Daily write limit reached (128 writes per token).", Math.max(1, Math.ceil((receipts[0]!.at + DAY - now) / 1000)));
		const data = await perform(ctx, member, name, args, token.name);
		await ctx.db.patch(token._id, { lastOperation: name, ...(write && key ? { receipts: [...receipts, { key, operation: name, fingerprint, at: now, result: data }] } : {}) });
		return { status: 200, data };
	},
});

// Parsed input is dispatched by operation. Keep the narrower casts at each branch.
type Input = { typeId?: string; recordId?: string; pageId?: string; parentId?: string; chatId?: string; threadId?: string; cursor?: string | null; limit?: number; title?: string; text?: string; values?: Record<string, unknown> };
async function authorize(ctx: MutationCtx, member: Member, name: IntegrationOperation, args: Input) {
	const write = integrationOperations[name].scope.endsWith(":write");
	if (write && name.startsWith("records_")) checkPermission(member, "records.edit");
	if (write && name.startsWith("pages_")) checkPermission(member, "pages.edit");
	if (name === "messages_post") {
		const chat = await requireChatToPost(ctx, member, normalize(ctx, "chats", args.chatId!));
		requirePost(member, chat);
		if (chat.archived) throw new ConvexError("Chat is archived.");
	}
	if (args.typeId) await requireType(ctx, member, normalize(ctx, "recordTypes", args.typeId), write ? "edit" : "view");
	if (args.recordId) await requireRecord(ctx, member, normalize(ctx, "records", args.recordId), write ? "edit" : "view");
	if (args.pageId || args.parentId) await requirePage(ctx, member, normalize(ctx, "pages", (args.pageId ?? args.parentId)!), write ? "edit" : "view");
	if (args.chatId) await requireChat(ctx, member, normalize(ctx, "chats", args.chatId));
}
async function perform(ctx: MutationCtx, member: Member, name: IntegrationOperation, args: Input, external: string): Promise<unknown> {
	const who = { member };
	const paginationOpts = { numItems: args.limit ?? 25, cursor: args.cursor ?? null };
	const workspaceId = member.workspaceId;
	if (name === "workspace_get") return { id: workspaceId, name: (await ctx.db.get(workspaceId))!.name };
	if (name === "databases_list") {
		const page = await ctx.db.query("recordTypes").withIndex("by_workspace", q => q.eq("workspaceId", workspaceId)).paginate(paginationOpts);
		const visible = typeVisible(ctx, member);
		const shown = fieldsShown(ctx, member);
		const rows = [];
		for (const t of page.page) if (!t.archived && await visible(t._id)) rows.push({ id: t._id, key: t.key, name: t.name, plural: t.plural, fields: await Promise.all((await fieldsOf(ctx, t._id)).filter(f => !f.archived).map(f => shown(f))) });
		return { ...page, page: rows };
	}
	if (name === "records_list") {
		const typeId = normalize(ctx, "recordTypes", args.typeId!);
		const fields = await fieldsOf(ctx, typeId);
		const page = await listRecords(ctx, workspaceId, { typeId, fields }, { archived: false, conditions: [], paginationOpts });
		return { ...page, page: await toRows(ctx, member, page.page.map(record => ({ record, fields }))) };
	}
	if (name === "records_get") {
		const record = await requireRecord(ctx, member, normalize(ctx, "records", args.recordId!));
		return (await toRows(ctx, member, [{ record, fields: await fieldsOf(ctx, record.typeId) }]))[0] ?? null;
	}
	if (name === "records_create") return createRecord(ctx, who, normalize(ctx, "recordTypes", args.typeId!), args.values!);
	if (name === "records_update") {
		await updateRecord(ctx, who, normalize(ctx, "records", args.recordId!), args.values!);
		return { id: args.recordId };
	}
	if (name === "pages_list") {
		const page = await ctx.db.query("pages").withIndex("by_workspace", q => q.eq("workspaceId", workspaceId).eq("recordId", undefined).eq("archived", false)).paginate(paginationOpts);
		const visible = pageVisible(ctx, member);
		const rows = [];
		for (const p of page.page) if (await visible(p) && !(await pageState(ctx, p)).archived) rows.push({ id: p._id, title: p.title, kind: kindOf(p) });
		return { ...page, page: rows };
	}
	if (name === "pages_get") {
		const p = await requirePage(ctx, member, normalize(ctx, "pages", args.pageId!));
		const doc = kindOf(p) === "folder" ? null : await withPageTitles(ctx, member, JSON.stringify((await readDoc(ctx, p._id)).toJSON()));
		return { id: p._id, title: p.title, doc };
	}
	if (name === "pages_create") {
		const id = await createPage(ctx, who, { title: args.title!, ...(args.parentId && { parentId: normalize(ctx, "pages", args.parentId) }) });
		if (args.text) await writeBlocks(ctx, who, (await ctx.db.get(id))!, paragraphs(args.text), "append");
		return { id };
	}
	if (name === "pages_append") {
		const p = await requirePage(ctx, member, normalize(ctx, "pages", args.pageId!));
		await writeBlocks(ctx, who, p, paragraphs(args.text!), "append");
		return { id: p._id };
	}
	if (name === "chats_list") {
		const page = await ctx.db.query("chats").withIndex("by_workspace", q => q.eq("workspaceId", workspaceId)).paginate(paginationOpts);
		const names = namer(ctx);
		const rows = [];
		for (const c of page.page) if (!c.archived && await canSee(ctx, c, member)) rows.push({ id: c._id, kind: c.kind, name: await chatLabel(ctx, c, names, member.userId) });
		return { ...page, page: rows };
	}
	const chatId = normalize(ctx, "chats", args.chatId!);
	const threadId = args.threadId ? normalize(ctx, "chatMessages", args.threadId) : undefined;
	if (name === "messages_list") return readMessages(ctx, member, chatId, threadId, paginationOpts);
	if (name === "messages_post") return { id: await sendMessage(ctx, who, { chatId, threadId, text: args.text!, mentions: { userIds: [], agentIds: [] } }, external) };
	throw new ConvexError("Unknown operation.");
}
