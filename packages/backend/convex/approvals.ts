import {
	APPROVAL_TTL_MS,
	actionLabel,
	alwaysAllowText,
	askText,
	approvalHash,
	approvalStatus,
	type Bound,
	builtinTools,
	callEnd,
	canDecideApproval,
	canonicalJson,
	clipJson,
	toolGroup,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { components, internal } from "./_generated/api";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { logCall } from "./activity";
import { autonomyProblem, isHandoff } from "./agentPolicy";
import { mutation, query } from "./functions";
import { automationName, automationScope } from "./automationOps";
import { canSee, findOrCreateDm, insertMessage, namer } from "./chatOps";
import { titleOf } from "./connectorTools";
import { connectorIn } from "./connectorAccess";
import { type Member, erased, getMember, liveWorkspace, memberOf, nameOf, requireLiveAgent, requireMember, sweepExpired, toActor } from "./lib";
import { decideFor, setRule } from "./permissions";
import { canReadReplyDetails, canReadSources, readReplyDetails } from "./replyPrivacy";
import { fieldsOf, requireRecord, typesOf } from "./recordOps";
import { requirePage } from "./pageOps";
import { reach } from "./placeAccess";
import { writeSources } from "./replySources";
import { type Op, opArg, risk } from "./schema";
export type { Op };
import { enqueueTurn, runningTurn } from "./turns";

// Approvals: a tool call an agent held until the person it acts for says yes (core
// approvals.ts). Automation cards go to the actor's DM; deciding queues a turn in the original
// place (so the one-turn-per-place queue holds); that turn runs the call if approved,
// with the exact stored input, then tells the agent what happened.

/** A page's content revision: the editor's step count (prosemirror-sync), which every edit and restore moves on. */
const pageRevision = async (ctx: QueryCtx, page: Doc<"pages"> | null) =>
	page ? ((await ctx.runQuery(components.prosemirrorSync.lib.latestVersion, { id: page._id })) ?? 0) : null;

/** The current revision of one thing a call depends on, or null when it's gone (or not this workspace's). */
async function revisionOf(ctx: QueryCtx, workspaceId: Id<"workspaces">, { kind, id }: Bound): Promise<number | string | null> {
	const ours = <T extends { workspaceId: Id<"workspaces"> }>(doc: T | null) => (doc && doc.workspaceId === workspaceId ? doc : null);
	const norm = ctx.db.normalizeId.bind(ctx.db);
	switch (kind) {
		case "page": {
			const pageId = norm("pages", id);
			return pageRevision(ctx, pageId && ours(await ctx.db.get(pageId)));
		}
		case "pageVersion": {
			const versionId = norm("pageVersions", id);
			const version = versionId && (await ctx.db.get(versionId));
			return pageRevision(ctx, version ? ours(await ctx.db.get(version.pageId)) : null);
		}
		case "recordPage": {
			const recordId = norm("records", id);
			const page = recordId && (await ctx.db.query("pages").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("recordId", recordId)).first());
			// A record nobody has written in has no page yet: that's its first revision.
			return page ? pageRevision(ctx, page) : 0;
		}
		case "record": {
			const recordId = norm("records", id);
			return (recordId && ours(await ctx.db.get(recordId)))?.updatedAt ?? null;
		}
		case "memory": {
			const memoryId = norm("memories", id);
			return (memoryId && ours(await ctx.db.get(memoryId)))?.version ?? null;
		}
		case "message": {
			const messageId = norm("chatMessages", id);
			const message = messageId && ours(await ctx.db.get(messageId));
			return message ? (message.editedAt ?? 0) : null;
		}
		case "agent": {
			const agentId = norm("agents", id);
			return (agentId && ours(await ctx.db.get(agentId)))?.version ?? null;
		}
		case "skill": {
			const row = await ctx.db.query("skillInstalls").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("skillId", id)).first();
			return row ? (row.custom?.version ?? row.definition?.version ?? 0) : null;
		}
		case "automation": {
			const row = await ctx.db.query("automationInstalls").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("automationId", id)).first();
			return row ? (row.custom?.version ?? row.definition?.version ?? 0) : null;
		}
	}
}

/**
 * What a built-in call's effect depends on, at its current revisions (core `ToolDef.binds`), as canonical JSON;
 * undefined when it depends on nothing. Hashed with the input, so the card locks to what it showed.
 */
async function boundRevisions(ctx: QueryCtx, workspaceId: Id<"workspaces">, tool: string, input: unknown) {
	const binds = builtinTools.find((t) => t.id === tool)?.binds?.(input) ?? [];
	const refs = await recordRefs(ctx, workspaceId, tool, input);
	if (!binds.length && refs === undefined) return undefined;
	const revisions = await Promise.all(binds.map(async (b) => ({ ...b, revision: await revisionOf(ctx, workspaceId, b) })));
	return canonicalJson(refs === undefined ? revisions : { revisions, refs });
}

const RECORD_WRITES = new Set(["records.save", "records.save_field", "records.save_database", "records.save_view"]);
type RecordWrite = {
	id?: string;
	type?: string;
	field?: string;
	values?: Record<string, unknown>;
	options?: (string | { id?: string; label: string })[];
	linksTo?: string;
	kind?: string;
	multiple?: boolean;
	preview?: boolean;
	trash?: boolean;
	sort?: { field: string } | null;
	columns?: string[];
	groupBy?: string | null;
	filters?: { field?: string }[];
};

/**
 * What a record write's changeable names mean right now: its database and fields by id, its choice values by
 * option id. Keys and labels can come to mean something else (a field archived, purged and made again with the
 * same key; a choice label moved to another option), and then the held call doesn't run. Archiving a field or a
 * database also binds what it affects: the database's newest live and archived record changes, so a record added
 * or changed after the approval stops it.
 */
async function recordRefs(ctx: QueryCtx, workspaceId: Id<"workspaces">, tool: string, input: unknown) {
	if (!RECORD_WRITES.has(tool) || !input || typeof input !== "object") return undefined;
	const i = input as RecordWrite;
	const types = await typesOf(ctx, workspaceId);
	const typeOf = (ref: string) => {
		const r = ref.trim();
		return types.find((t) => t._id === r || t.key === r) ?? types.find((t) => t.key === r.toLowerCase()) ?? null;
	};
	const recordId = tool === "records.save" && i.id ? ctx.db.normalizeId("records", i.id) : null;
	const record = recordId ? await ctx.db.get(recordId) : null;
	const type = record ? (types.find((t) => t._id === record.typeId) ?? null) : i.type !== undefined ? typeOf(i.type) : null;
	const fields = type ? await fieldsOf(ctx, type._id) : [];
	const fieldOf = (key: string) => fields.find((f) => f.key === key.trim()) ?? fields.find((f) => f.key === key.trim().toLowerCase()) ?? null;
	const optionOf = (f: Doc<"recordFields">, label: unknown) =>
		typeof label !== "string" ? label : (f.options?.find((o) => !o.retired && (o.id === label.trim() || o.label.toLowerCase() === label.trim().toLowerCase()))?.id ?? null);
	const valueRef = (key: string, value: unknown) => {
		const f = fieldOf(key);
		if (!f) return null;
		return f.kind === "choice" ? { id: f._id, options: (Array.isArray(value) ? value : [value]).map((x) => optionOf(f, x)) } : { id: f._id };
	};
	const refs: Record<string, unknown> = { type: type?._id ?? null };
	if (i.values) refs.values = Object.fromEntries(Object.entries(i.values).map(([k, value]) => [k, valueRef(k, value)]));
	const field = tool === "records.save_field" && i.field !== undefined ? fieldOf(i.field) : undefined;
	if (field !== undefined) refs.field = field ? [field._id, field.updatedAt] : null;
	if (tool === "records.save_field" && i.options)
		refs.options = i.options.map((o) => (typeof o === "string" ? (field ? optionOf(field, o) : null) : (o.id ?? (field ? optionOf(field, o.label) : null))));
	if (i.linksTo !== undefined) refs.linksTo = typeOf(i.linksTo)?._id ?? null;
	if (tool === "records.save_view")
		refs.fields = [i.sort?.field, i.groupBy, ...(i.columns ?? []), ...(i.filters ?? []).map((f) => f.field)].map((k) => (typeof k === "string" ? (fieldOf(k)?._id ?? null) : null));
	// Changing a field's kind rewrites its records' values: a record changed after the approval stops it, as for archiving.
	const reshapes = tool === "records.save_field" && !!i.field && !i.preview && (i.kind !== undefined || i.multiple !== undefined || i.linksTo !== undefined);
	if ((i.trash === true || reshapes) && type && (tool === "records.save_field" || tool === "records.save_database")) {
		const newest = (archived: boolean) =>
			ctx.db.query("records").withIndex("by_type_updated", (q) => q.eq("typeId", type._id).eq("archived", archived)).order("desc").first();
		const [live, gone] = await Promise.all([newest(false), newest(true)]);
		refs.contents = [type.updatedAt, live?._id ?? null, live?.updatedAt ?? null, gone?._id ?? null, gone?.updatedAt ?? null];
	}
	return refs;
}

/**
 * Written by the runner when the model makes a call that needs approval. `input` is canonical JSON.
 * It names what it changes by id (core tools), and binds the revisions of anything its effect depends on.
 */
export const request = internalMutation({
	args: { turnId: v.id("agentTurns"), callId: v.string(), tool: v.string(), input: v.string(), risk, why: v.optional(v.string()) },
	handler: async (ctx, { turnId, callId, tool, input, risk, why }) => {
		const { turn, member } = await runningTurn(ctx, turnId);
		// One call id holds one approval: a repeated request (a retried step) gets the same card, never a second one to run.
		const held = await ctx.db.query("approvals").withIndex("by_call", (q) => q.eq("turnId", turnId).eq("callId", callId)).first();
		if (held) return { approvalId: held._id, separate: held.replyId !== turn.replyId };
		const bound = await boundRevisions(ctx, turn.workspaceId, tool, JSON.parse(input));
		const { automation, trigger } = await automationScope(ctx, turn);
		// Automation and wake cards belong only in the acting person's DM, even for channel/thread runs.
		// Keep chatId/threadId as the execution place: implicit targets must not change on approval.
		const dmId = (trigger?.automation || turn.wakeupId) && await findOrCreateDm(ctx, turn.workspaceId, turn.actorId, [turn.actorId], [turn.agentId]);
		// In the DM itself it goes in the reply, which is shown with it (turns.ts `show`).
		const separate = !!dmId && dmId !== turn.chatId;
		const replyId = separate ? await insertMessage(ctx, (await ctx.db.get(dmId!))!, {
			authorAgentId: turn.agentId, usedPlaces: await writeSources(ctx, member, { filtered: true, preserveOwn: true }), repliedTo: turn.actorId, text: "", parts: [], mentions: { userIds: [], agentIds: [] }, status: "done",
		}) : turn.replyId;
		const approvalId = await ctx.db.insert("approvals", {
			workspaceId: turn.workspaceId,
			agentId: turn.agentId,
			actorId: turn.actorId,
			chatId: turn.chatId,
			threadId: turn.threadId,
			turnId,
			replyId,
			callId,
			tool,
			input,
			...(bound !== undefined && { bound }),
			hash: await approvalHash(tool, JSON.parse(input), bound),
			status: "pending",
			expiresAt: Date.now() + APPROVAL_TTL_MS,
			risk,
			automationInstallId: automation?._id,
		});
		if (separate) await ctx.db.patch(replyId, { parts: [{ type: "approval", id: callId, approvalId, tool, ...(why && { why }) }] });
		return { approvalId, separate };
	},
});

/**
 * Whether the card may offer "Always allow", read live (someone with actions.lock may have locked it
 * since), and the automation a grant would be scoped to. Old rows without a risk: no.
 */
async function alwaysFor(ctx: QueryCtx, row: Doc<"approvals">) {
	const member = await memberOf(ctx, row.actorId, row.workspaceId);
	if (!row.risk || !member) return null;
	// A removed automation cannot leave behind a wider Always grant, whether it went after the
	// call was held or before (its run keeps going, and `request` then has no install to record).
	const automation = row.automationInstallId ? await ctx.db.get(row.automationInstallId) : null;
	// A wake has no automation to scope a grant to, so its cards never offer Always.
	if ((await ctx.db.get(row.turnId))?.wakeupId) return null;
	if (row.automationInstallId && (!automation || automation.archived)) return null;
	const turn = !row.automationInstallId && (await ctx.db.get(row.turnId));
	if (turn && turn.triggerId && (await ctx.db.get(turn.triggerId))?.automation) return null;
	// Acting-as-you calls ask only in others' automations, and an Always for them is scoped to it.
	const { decision } = await decideFor(ctx, member, { action: row.tool, risk: row.risk, foreign: !!automation });
	if (decision.type !== "ask" || !decision.canAlways) return null;
	return { member, automation };
}

/** A reply's held calls, if the person can see its chat. Results show only to the person the agent acted for. */
export const forReply = query({
	args: { replyId: v.id("chatMessages") },
	handler: async (ctx, { replyId }) => {
		const member = await getMember(ctx);
		const reply = await ctx.db.get(replyId);
		const chat = reply && (await ctx.db.get(reply.chatId));
		if (!member || !chat || chat.archived || !(await canSee(ctx, chat, member)) || !(await canReadReplyDetails(ctx, member, reply!))) return [];
		// Bounded: a reply holding more calls than this shows the first ones (the app says the rest aren't shown).
		const rows = await ctx.db
			.query("approvals")
			.withIndex("by_reply", (q) => q.eq("replyId", replyId))
			.take(APPROVALS_PER_REPLY);
		const names = namer(ctx);
		const ids = idNamer(ctx, member);
		const card = async (row: Doc<"approvals">) => {
			const mine = canDecideApproval(toActor(member), row);
			const group = toolGroup(row.tool);
			const connector = (await connectorIn(ctx, row.workspaceId, group)) ?? null;
			const always = mine && approvalStatus(row) === "pending" ? await alwaysFor(ctx, row) : null;
			const title = await titleOf(ctx, row.workspaceId, row.tool);
			// A skill proposal may be private even when its write is later refused.
			const privateInput = row.actorId !== member.userId && (row.tool === "skills.create" || row.tool === "skills.edit");
			const shownInput = privateInput ? "{}" : row.input;
			const input: unknown = JSON.parse(shownInput);
			const automation = row.automationInstallId && (await ctx.db.get(row.automationInstallId));
			const def = builtinTools.find((t) => t.id === row.tool);
			const named = await namedInput(ids, input);
			const action = def?.action?.(input) ?? actionLabel(row.tool, title);

			return {
				_id: row._id,
				callId: row.callId,
				tool: row.tool,
				/** The service's name ("Night Owl"), or null for built-ins. */
				service: connector?.name ?? null,
				/** What this call does, for people: "Send SMS", "Archive page". */
				action,
				/** The ask: "I'd like to send an email to dana@acme.com from your Gmail.", or "Monday summary wants to post in #general as you." */
				ask: askText(row.tool, connector, input, {
					title,
					said: (named.target && def?.label?.(input, { title: named.target, name: named.target })) || def?.label?.(input) || (def?.action ? action : undefined),
					automation: automation ? automationName(automation) : undefined,
				}),
				/** The input as the card shows it: ids as names this viewer can see, never a hidden place's. Null: not fields. */
				fields: named.fields?.filter((f) => !def?.actionKeys?.includes(f.key)) ?? null,
				/** The automation whose run made the call, so the card says where the agent's words came from. */
				automation: automation ? automationName(automation) : null,
				/** Set when "Always allow" would cover only this automation's runs. */
				alwaysAutomation: always?.automation ? automationName(always.automation) : null,
				/** Null when "Always allow" isn't offered (locked, or not yours to decide). */
				alwaysText: always
					? alwaysAllowText(row.tool, connector, { automation: always.automation ? automationName(always.automation) : undefined, title })
					: null,
				/** Set when "Always allow" saved a rule. */
				always: row.always ?? false,
				/** The exact input that will run, as canonical JSON. */
				input: shownInput,
				hash: row.hash,
				status: approvalStatus(row),
				/** With `failed`: it may or may not have happened (older apps show only the error). */
				outcome: row.outcome ?? null,
				approver: (await names.user(row.actorId)).name,
				canDecide: mine,
				expiresAt: row.expiresAt,
				decidedAt: row.decidedAt ?? null,
				result: mine ? (row.result ?? null) : null,
				error: privateInput ? null : row.error ?? null,
			};
		};
		// In order, so the shared name budget goes to the first cards, the same way every time.
		const cards = [];
		for (const row of rows) cards.push(await card(row));
		return cards;
	},
});

/** Most cards `forReply` returns for one reply. */
export const APPROVALS_PER_REPLY = 50;
/** Ids named per card, and per query across its cards: each name is a few reads through the shared readers. */
export const NAMED_IDS_PER_CARD = 20;
export const NAMED_IDS_PER_QUERY = 200;

type IdName = { name: string; seen: boolean };

/**
 * Names ids for one viewer across one query's cards: each id is looked up once, and at most
 * NAMED_IDS_PER_QUERY are, so a reply holding many calls (or one call naming hundreds) still loads.
 */
function idNamer(ctx: QueryCtx, member: Member) {
	// Promises, claimed before awaiting, so cards resolving at once share lookups and never overspend.
	const names = new Map<string, Promise<IdName | null>>();
	return {
		/** Whether this string is an id of a kind `idName` names: no reads. */
		isId: (s: string) => ID_TABLES.some((table) => ctx.db.normalizeId(table, s) !== null),
		/** Its name, or undefined once the query's budget is spent (left unresolved). */
		name(id: string): Promise<IdName | null | undefined> {
			let named = names.get(id);
			if (!named) {
				if (names.size >= NAMED_IDS_PER_QUERY) return Promise.resolve(undefined);
				named = idName(ctx, member, id);
				names.set(id, named);
			}
			return named;
		},
	};
}

/**
 * A held call's input for its card: each id it names as what this viewer may see ("Old pricing notes",
 * "#sales"), or what it is ("a page you can't see"), never a hidden place's name. `target` is the name of
 * what it acts on (its `page`, `id` or `record`), when the viewer can see it. A manage tool's `request`
 * shows its fields. At most NAMED_IDS_PER_CARD ids are named; a list past that ends "and N more", and other
 * ids past it stay as they are. What runs is still the exact stored input (Raw).
 */
async function namedInput(ids: ReturnType<typeof idNamer>, input: unknown) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return { fields: null, target: undefined };
	const top = input as Record<string, unknown>;
	const request = Object.keys(top).length === 1 && top.request && typeof top.request === "object" && !Array.isArray(top.request) ? (top.request as Record<string, unknown>) : top;
	const counted = new Set<string>();
	const nameOf = async (id: string) => {
		if (!counted.has(id)) {
			if (counted.size >= NAMED_IDS_PER_CARD) return undefined;
			counted.add(id);
		}
		return await ids.name(id);
	};
	const scalar = async (v: unknown) => typeof v === "string" && ids.isId(v) ? (await nameOf(v))?.name ?? v : v;
	const shown = async (v: unknown): Promise<unknown> => {
		if (!Array.isArray(v)) return scalar(v);
		const out: unknown[] = [];
		let more = 0;
		for (const item of v) {
			if (typeof item === "string" && ids.isId(item)) {
				const named = await nameOf(item);
				if (named === undefined) more++;
				else out.push(named?.name ?? item);
			} else out.push(item);
		}
		return more ? [...out, `and ${more} more`] : out;
	};
	let target: string | undefined;
	for (const key of ["page", "id", "record"]) {
		const named = typeof request[key] === "string" && ids.isId(request[key]) ? await nameOf(request[key]) : null;
		if (named) { target = named.seen ? named.name : undefined; break; }
	}
	const fields = [];
	for (const [key, value] of Object.entries(request)) fields.push({ key, value: await shown(value) });
	return { fields, target };
}

const ID_TABLES = ["pages", "records", "recordTypes", "chats", "users", "agents", "chatMessages"] as const;

/** What an id names for this viewer, or null if it isn't one of these kinds. Gates are the shared readers'. */
async function idName(ctx: QueryCtx, member: Member, id: string): Promise<IdName | null> {
	const hidden = (name: string) => ({ name, seen: false });
	const seen = (name: string) => ({ name, seen: true });
	const pageId = ctx.db.normalizeId("pages", id);
	if (pageId) {
		if (!(await ctx.db.get(pageId))) return hidden("a deleted page");
		return await requirePage(ctx, member, pageId).then((p) => seen(p.title || "Untitled"), () => hidden("a page you can't see"));
	}
	const recordId = ctx.db.normalizeId("records", id);
	if (recordId) {
		if (!(await ctx.db.get(recordId))) return hidden("a deleted record");
		return await requireRecord(ctx, member, recordId).then((r) => seen(r.title || "Untitled"), () => hidden("a record you can't see"));
	}
	const typeId = ctx.db.normalizeId("recordTypes", id);
	if (typeId) {
		const type = await ctx.db.get(typeId);
		return type && type.workspaceId === member.workspaceId && reach(member, type.access) && await canReadSources(ctx, member, type.usedPlaces) ? seen(type.plural) : hidden("a database you can't see");
	}
	const chatId = ctx.db.normalizeId("chats", id);
	if (chatId) {
		const chat = await ctx.db.get(chatId);
		if (chat && await canSee(ctx, chat, member)) return seen(chat.kind === "channel" ? `#${chat.name}` : "a direct message");
		return hidden(chat?.kind === "channel" ? "a channel you can't see" : "a conversation you can't see");
	}
	const userId = ctx.db.normalizeId("users", id);
	if (userId) return await memberOf(ctx, userId, member.workspaceId) ? seen(await nameOf(ctx, userId)) : hidden("someone");
	const agentId = ctx.db.normalizeId("agents", id);
	if (agentId) {
		const agent = await ctx.db.get(agentId);
		return agent?.workspaceId === member.workspaceId ? seen(agent.name) : hidden("an agent");
	}
	if (ctx.db.normalizeId("chatMessages", id)) return hidden("a message");
	return null;
}

/**
 * Approve or deny. `hash` is the one the approver was shown: if it doesn't match the
 * stored call exactly, nothing is decided. Only the person the agent acted for can
 * decide, while they can still see the chat, before it expires.
 */
export const decide = mutation({
	/**
	 * `always`: also save a rule so it stops asking.
	 */
	args: { approvalId: v.id("approvals"), hash: v.string(), approve: v.boolean(), always: v.boolean() },
	handler: async (ctx, { approvalId, hash, approve, always }) => {
		const member = await requireMember(ctx);
		const row = await ctx.db.get(approvalId);
		const chat = row && row.workspaceId === member.workspaceId ? await ctx.db.get(row.chatId) : null;
		if (!row || !chat || chat.archived || !(await canSee(ctx, chat, member))) throw new ConvexError("Approval not found.");
		const reply = await ctx.db.get(row.replyId);
		if (!reply || !(await canReadReplyDetails(ctx, member, reply))) throw new ConvexError("Approval not found.");
		if (!canDecideApproval(toActor(member), row)) {
			throw new ConvexError(`Only ${await nameOf(ctx, row.actorId)} can decide this. The agent is acting for them.`);
		}
		const status = approvalStatus(row);
		if (status === "expired") throw new ConvexError("This request expired. Ask the agent again.");
		// Lost a race (another device, a double click): the card already shows the outcome. Not an error,
		// since the client logs every failed mutation to the console.
		if (status !== "pending") return { decided: false };
		if (hash !== row.hash) throw new ConvexError("This action isn't the one you were shown. Nothing ran.");
		const agent = await requireLiveAgent(ctx, member, row.agentId);

		if (approve && always) {
			const allowed = await alwaysFor(ctx, row);
			if (!allowed) throw new ConvexError("Always allow isn't available here: this action always asks, or its automation was deleted. Nothing ran.");
			await setRule(ctx, allowed.member, { action: row.tool, setting: "always", automationInstallId: allowed.automation?._id, risk: row.risk });
		}
		await ctx.db.patch(approvalId, { status: approve ? "approved" : "denied", decidedAt: Date.now(), ...(approve && always && { always: true }) });
		const asked = await ctx.db.get(row.turnId);
		await enqueueTurn(ctx, chat, {
			agentId: row.agentId,
			chatId: row.chatId,
			threadId: row.threadId,
			// The message that started it all, so the decision's reaction lands on the person's message.
			// An old welcome turn had none: then there's nothing to react to.
			triggerId: asked ? asked.triggerId : row.replyId,
			actorId: row.actorId,
			approvalId,
			// A wake's follow-up turn stays a wake, as trusted as the wake.
			...(asked?.wakeupId && { wakeupId: asked.wakeupId }),
			// Still in its chain of agents, or still answering another agent's ask (chains.ts).
			...(asked?.chain && { chain: asked.chain }),
			...(asked?.ask && { ask: asked.ask }),
			// Approval permits this action; it does not override the workspace's participation switches.
			...(asked?.routed && { routed: true as const }),
			...(asked && isHandoff(asked) && { handoff: true as const }),
		});
		return { decided: true };
	},
});

/**
 * Called by the turn that follows an approval, right before running it. Moves it from
 * approved to running (once), and re-checks the lock: the stored call must still hash
 * to what was approved. Returns the exact call to run, or null.
 */
export const claim = internalMutation({
	/** `outside`: the call goes to a service outside the workspace, so cut off, its outcome is unknown (turns.ts `settleApproval`). */
	args: { approvalId: v.id("approvals"), turnId: v.id("agentTurns"), outside: v.optional(v.boolean()) },
	handler: async (ctx, { approvalId, turnId, outside }): Promise<{ tool: string; input: unknown } | null> => {
		const [row, turn] = await Promise.all([ctx.db.get(approvalId), ctx.db.get(turnId)]);
		if (!row || row.status !== "approved" || turn?.status !== "running" || turn.approvalId !== approvalId) return null;
		const policyProblem = await autonomyProblem(ctx, turn);
		if (policyProblem) {
			await ctx.db.patch(approvalId, { status: "failed", error: policyProblem });
			return null;
		}
		const member = await memberOf(ctx, row.actorId, row.workspaceId);
		const chat = await ctx.db.get(row.chatId);
		if (!member || !chat || chat.archived || !(await canSee(ctx, chat, member))) return null;
		member.replyId = turn.replyId;
		const reply = await ctx.db.get(row.replyId);
		if (!(await canReadReplyDetails(ctx, member, reply))) return null;
		const input: unknown = JSON.parse(row.input);
		if ((await approvalHash(row.tool, input, row.bound)) !== row.hash) {
			await ctx.db.patch(approvalId, { status: "failed", error: "The stored action no longer matches what was approved." });
			return null;
		}
		// What it changes must still be as it was on the card: an edit since stops it rather than run on unseen content.
		if (row.bound !== undefined && (await boundRevisions(ctx, row.workspaceId, row.tool, input)) !== row.bound) {
			await ctx.db.patch(approvalId, { status: "failed", error: EDITED });
			return null;
		}
		// Rules are read fresh: a block or Never set since the approval wins.
		// Stored rows without risk were never backfilled; treat them conservatively.
		const { decision } = member ? await decideFor(ctx, member, { action: row.tool, risk: row.risk ?? "outside" }) : { decision: null };
		if (decision?.type === "deny") {
			const who = decision.by === "owner" ? "A workspace owner blocked this" : `${await nameOf(ctx, row.actorId)} set this to Never`;
			await ctx.db.patch(approvalId, { status: "failed", error: `${who} after it was approved, so it didn't run.` });
			return null;
		}
		await readReplyDetails(ctx, member, reply);
		await ctx.db.patch(approvalId, { status: "running", ...(outside && { outside: true }) });
		return { tool: row.tool, input };
	},
});

/** What an approved call's line in Activity says about how it was allowed. */
const allowedOf = (row: Doc<"approvals">) => ({ how: row.always ? ("always" as const) : ("once" as const), by: row.actorId, at: row.decidedAt ?? Date.now() });

/** Marks a running approval done or failed (`unknown`: may or may not have happened), and logs its call, once: whichever of the effect or the runner gets there first. */
async function settle(ctx: MutationCtx, row: Doc<"approvals">, turnId: Id<"agentTurns">, end: { result?: string; error?: string; unknown?: boolean }) {
	const status = end.error === undefined ? "done" : "failed";
	// Only the actor sees the result: once their account is erased, it's not kept.
	const result = status === "done" && !(await erased(ctx, row.actorId)) ? end.result : undefined;
	await ctx.db.patch(row._id, { status, ...(result !== undefined && { result }), ...(end.error !== undefined && { error: end.error }), ...(end.error !== undefined && end.unknown && { outcome: "unknown" as const }) });
	await logCall(ctx, { turnId, callId: `approval-${row._id}`, tool: row.tool, changes: true, input: clipJson(JSON.parse(row.input)), output: end.result, error: end.error, allowed: allowedOf(row) });
}

/**
 * A tool call's operation key: the approval it runs from, or the model's call id. Every write a built-in makes
 * for a call carries it, so the same call never writes twice (a retried step, a duplicate delivery).
 */
const opKey = (op: Op) => ("call" in op ? op.call : `approval-${op.approval}`);
const ALREADY_RAN = "This call already ran, or was stopped, so it didn't run again.";
const EDITED = "What this changes was edited after it was approved, so it didn't run. Ask again if you still want it.";

/** How long a done receipt is kept: far past any retry of the same call (a turn goes stale in minutes). */
export const RECEIPT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const receiptOf = (ctx: QueryCtx, turnId: Id<"agentTurns">, callId: string) =>
	ctx.db.query("toolReceipts").withIndex("by_turn", (q) => q.eq("turnId", turnId).eq("callId", callId)).first();

/** Saves a receipt, only for a turn in a live workspace: a deleted one's cascade may already be past this table. */
async function addReceipt(ctx: MutationCtx, turnId: Id<"agentTurns">, callId: string, state: "started" | "done", output?: string) {
	const turn = await ctx.db.get(turnId);
	if (!turn || !(await liveWorkspace(ctx, turn.workspaceId))) throw new ConvexError("This reply was stopped.");
	return ctx.db.insert("toolReceipts", { turnId, callId, actorId: turn.actorId, state, ...(output !== undefined && { output }) });
}

/**
 * Claims `op` in the caller's transaction: refused if a write with this key already committed, or (approved
 * calls) if the approval isn't running for this turn, or what it changes was edited since it was approved.
 * Checked here, with the effect, not only at `claim`, so an edit in between can't slip through.
 */
async function claimOp(ctx: MutationCtx, op: Op, turnId: Id<"agentTurns">): Promise<{ row?: Doc<"approvals"> } | { error: string }> {
	if (await receiptOf(ctx, turnId, opKey(op))) return { error: ALREADY_RAN };
	if ("call" in op) return {};
	const [row, turn] = await Promise.all([ctx.db.get(op.approval), ctx.db.get(turnId)]);
	if (row?.status !== "running" || turn?.approvalId !== op.approval) return { error: ALREADY_RAN };
	if (row.bound !== undefined && (await boundRevisions(ctx, row.workspaceId, row.tool, JSON.parse(row.input))) !== row.bound) {
		await settle(ctx, row, turnId, { error: EDITED });
		return { error: EDITED };
	}
	return { row };
}

/**
 * A built-in call's effect and its receipt, in one transaction. An approved call's approval is settled in the
 * same write as the effect, so the card can never say it's running while it already happened, nor done while
 * it didn't. A second run with the same key writes nothing and says so. Without `op`, it just runs.
 */
export async function withReceipt<T>(ctx: MutationCtx, op: Op | undefined, turnId: Id<"agentTurns">, run: () => Promise<T>): Promise<T> {
	if (!op) return run();
	const claimed = await claimOp(ctx, op, turnId);
	if ("error" in claimed) return { error: claimed.error } as T;
	const output = await run();
	const end = callEnd(output);
	if (claimed.row) await settle(ctx, claimed.row, turnId, "output" in end ? { result: clipJson(end.output) } : { error: end.error });
	// A refused write changed nothing (asToolResult), so the model may fix it and try again; an approval runs once either way.
	if ("output" in end || claimed.row) await addReceipt(ctx, turnId, opKey(op), "done");
	return output;
}

/**
 * For a built-in whose effects span several transactions (making pictures, saving a file from the web: a
 * download or provider call, a stored file, attaching it): claims its key before it spends or writes anything,
 * so a rerun of the same call refuses instead of doing it twice. `finishOp` settles it; one that never does was
 * cut off, so its outcome is unknown (an approved one's card says it may or may not have happened).
 */
export const startOp = internalMutation({
	args: { turnId: v.id("agentTurns"), op: opArg },
	handler: async (ctx, { turnId, op }): Promise<string | null> => {
		const claimed = await claimOp(ctx, op, turnId);
		if ("error" in claimed) return claimed.error;
		await addReceipt(ctx, turnId, opKey(op), "started");
		return null;
	},
});

export const finishOp = internalMutation({
	args: { turnId: v.id("agentTurns"), op: opArg },
	handler: async (ctx, { turnId, op }) => {
		const receipt = await receiptOf(ctx, turnId, opKey(op));
		if (receipt?.state === "started") await ctx.db.patch(receipt._id, { state: "done" });
	},
});

/**
 * A connector call that changes something, and whose tool takes no idempotency key, claims its call id before
 * it's sent (core buildToolSet). A repeat of the same call isn't sent again: it gets what the first one returned,
 * or, if the first never finished, that it may or may not have happened. Null: go ahead.
 */
export const startCall = internalMutation({
	args: { turnId: v.id("agentTurns"), callId: v.string() },
	handler: async (ctx, { turnId, callId }): Promise<{ error: string } | { note: string; result: string | null } | null> => {
		const receipt = await receiptOf(ctx, turnId, callId);
		if (receipt?.state === "started") return { error: "This call was already sent and never finished, so it may or may not have happened. Check before trying again." };
		if (receipt) return { note: "This exact call already ran, so it wasn't sent again. What it returned then:", result: receipt.output ?? null };
		await addReceipt(ctx, turnId, callId, "started");
		return null;
	},
});

export const finishCall = internalMutation({
	args: { turnId: v.id("agentTurns"), callId: v.string(), output: v.string() },
	handler: async (ctx, { turnId, callId, output }) => {
		const receipt = await receiptOf(ctx, turnId, callId);
		if (receipt?.state !== "started") return;
		// Only its person sees it: once their account is erased, it's not kept.
		await ctx.db.patch(receipt._id, { state: "done", ...(!(await erased(ctx, receipt.actorId)) && { output }) });
	},
});

/** Done receipts a month old, a batch at a time. Started ones (outcome unknown) stay until their turn goes. */
export const forgetReceipts = internalMutation({
	args: {},
	handler: async (ctx) => {
		const old = ctx.db.query("toolReceipts").withIndex("by_state", (q) => q.eq("state", "done").lt("_creationTime", Date.now() - RECEIPT_KEEP_MS));
		await sweepExpired(ctx, old, (row) => ctx.db.delete(row._id), internal.approvals.forgetReceipts);
	},
});

/**
 * Records how an approved call went, and logs it, unless its effect already did (`withReceipt`).
 * `unknown`: an outside call that was cut off or failed in transit, so it may or may not have happened.
 */
export const finish = internalMutation({
	args: { approvalId: v.id("approvals"), turnId: v.id("agentTurns"), result: v.optional(v.string()), error: v.optional(v.string()), unknown: v.optional(v.boolean()) },
	handler: async (ctx, { approvalId, turnId, ...end }) => {
		const row = await ctx.db.get(approvalId);
		if (row?.status !== "running") return;
		await settle(ctx, row, turnId, end);
	},
});
