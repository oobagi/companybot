import {
	FIELD_AI_MESSAGES,
	FIELD_AI_MESSAGE_DELAY_MS,
	FIELD_AI_MODEL,
	FIELD_AI_QUIET_MS,
	type FieldAi,
	type FieldAiTrigger,
	type FieldValue,
	canFillWithAi,
	displayValues,
	fieldAiModeLabels,
	fieldAiRequest,
	fieldAiSchema,
	fieldAiTriggerLabels,
	fieldAiWrite,
	gatewayCost,
	normalizeFieldAi,
	normalizeValue,
} from "@companybot/core";
import { Output, generateText } from "ai";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { mutation, query } from "./functions";
import { type Member, type Who, getMember, liveWorkspace, requireMember } from "./lib";
import { applyValues, currencyOf, fieldsOf, logChange, requireEditableField, requireRecord, toField, updateRecord } from "./recordOps";
import { fieldAi } from "./schema";
import { recordUsage } from "./usage";

// AI that fills database fields (core field-ai.ts). A field's setting says what to write, when (a customer
// writes, or the conversation goes quiet) and how (only if empty, add to it, replace it, or suggest it). When a
// conversation linked to a record gets a message, each trigger's run is (re)scheduled on the conversation
// (`fillAt`), so a burst is one run. A run is one small model call with no tools: it reads the conversation and
// answers a value per field (or null: not said). The system picked the record (the conversation's), checks each
// value like any input, and writes it as AI (history says so, from which conversation; the value is marked
// until someone changes it). Customers can't steer it into other records or fields, and the agent answering
// them never edits records. Costs are the workspace's, kind "fields".

const describe = (ai: FieldAi | undefined) => (ai ? `${fieldAiTriggerLabels[ai.when]}, ${fieldAiModeLabels[ai.mode].label.toLowerCase()}: ${ai.instruction}` : "Off");

/** Turns AI on for a field (or off, with null), as the person editing it. Logged with the field's other changes. */
export async function setFieldAi(ctx: MutationCtx, who: Who, fieldId: Id<"recordFields">, raw: { instruction: string; when: string; mode: string } | null, kind?: Doc<"recordFields">["kind"]) {
	const field = await requireEditableField(ctx, who.member, fieldId);
	if (field.archived) throw new ConvexError("This field is in Archive. Restore it to make changes.");
	let next: FieldAi | undefined;
	if (raw) {
		const checked = normalizeFieldAi(kind ?? field.kind, raw);
		if ("error" in checked) throw new ConvexError(checked.error);
		next = checked;
	}
	if (describe(next) === describe(field.ai)) return;
	await ctx.db.patch(fieldId, { ai: next, updatedAt: Date.now() });
	await logChange(ctx, who, { typeId: field.typeId, fieldId, action: "field.updated", changes: [{ key: "ai", old: describe(field.ai), new: describe(next) }] });
}

/** Whether a database has fields AI fills on this trigger. */
async function fillsOn(ctx: QueryCtx, typeId: Id<"recordTypes">, when: FieldAiTrigger) {
	return (await fieldsOf(ctx, typeId)).some((f) => !f.archived && f.ai?.when === when && canFillWithAi(f.kind));
}

/**
 * After a customer's message: (re)schedules each trigger's run for the record it's linked to. "A customer writes"
 * runs a minute after the latest message; "goes quiet", half an hour after it.
 */
export async function scheduleFill(ctx: MutationCtx, c: Doc<"inboxConversations">) {
	const record = c.recordId && (await ctx.db.get(c.recordId));
	if (!record || record.archived) return;
	const now = Date.now();
	const fillAt: NonNullable<Doc<"inboxConversations">["fillAt"]> = { ...c.fillAt };
	for (const [when, wait] of [["message", FIELD_AI_MESSAGE_DELAY_MS], ["quiet", FIELD_AI_QUIET_MS]] as const) {
		if (!(await fillsOn(ctx, record.typeId, when))) continue;
		fillAt[when] = now + wait;
		await ctx.scheduler.runAt(now + wait, internal.fieldAi.run, { conversationId: c._id, when, at: now + wait });
	}
	if (fillAt.message !== c.fillAt?.message || fillAt.quiet !== c.fillAt?.quiet) await ctx.db.patch(c._id, { fillAt });
}

/** What a run reads: the record, its fields set to this trigger, and the conversation. Null when it's moved on or gone. */
export const context = internalQuery({
	args: { conversationId: v.id("inboxConversations"), when: v.union(v.literal("message"), v.literal("quiet")), at: v.number() },
	handler: async (ctx, { conversationId, when, at }) => {
		const c = await ctx.db.get(conversationId);
		// A later message rescheduled it: that run will do it.
		if (!c || c.fillAt?.[when] !== at || !c.recordId || !(await liveWorkspace(ctx, c.workspaceId))) return null;
		const record = await ctx.db.get(c.recordId);
		const type = record && (await ctx.db.get(record.typeId));
		if (!record || record.archived || !type || type.archived) return null;
		const all = await fieldsOf(ctx, record.typeId);
		const fields = all.filter((f) => !f.archived && !f.change && f.ai?.when === when && canFillWithAi(f.kind));
		if (!fields.length) return null;
		const shown = displayValues(fields.map(toField), record.values);
		const messages = (await ctx.db.query("inboxMessages").withIndex("by_conversation", (q) => q.eq("conversationId", c._id)).order("desc").take(FIELD_AI_MESSAGES * 2))
			.filter((m) => m.direction === "in" || (m.direction === "out" && m.status !== "draft" && m.status !== "failed"))
			.slice(0, FIELD_AI_MESSAGES)
			.reverse()
			.map((m) => ({ from: m.direction === "in" ? ("customer" as const) : ("us" as const), text: m.text }));
		if (!messages.length) return null;
		return {
			workspaceId: c.workspaceId,
			recordId: record._id,
			request: fieldAiRequest({
				database: type.plural,
				record: record.title,
				fields: fields.map((f) => ({ field: toField(f), instruction: f.ai!.instruction, now: shown[f.key] === undefined ? null : String(shown[f.key]) })),
				messages,
			}),
			fields: fields.map(toField),
		};
	},
});

export const run = internalAction({
	args: { conversationId: v.id("inboxConversations"), when: v.union(v.literal("message"), v.literal("quiet")), at: v.number() },
	handler: async (ctx, args) => {
		const found = await ctx.runQuery(internal.fieldAi.context, args);
		if (!found) return;
		const { output, providerMetadata } = await generateText({
			model: FIELD_AI_MODEL,
			instructions: found.request.instructions,
			prompt: found.request.prompt,
			output: Output.object({ schema: fieldAiSchema(found.fields), name: "fields" }),
			maxRetries: 1,
		});
		await ctx.runMutation(internal.fieldAi.apply, {
			...args,
			recordId: found.recordId,
			values: output as Record<string, unknown>,
			model: FIELD_AI_MODEL,
			costUsd: gatewayCost(providerMetadata),
		});
	},
});

/**
 * Writes what the run answered, field by field, by each field's mode as it is now: values checked like any input
 * (one that doesn't fit is skipped), "Suggest it" ones kept for someone to accept. Records the call's cost.
 */
export const apply = internalMutation({
	args: {
		conversationId: v.id("inboxConversations"),
		when: v.union(v.literal("message"), v.literal("quiet")),
		at: v.number(),
		recordId: v.id("records"),
		values: v.record(v.string(), v.any()),
		model: v.string(),
		costUsd: v.number(),
	},
	handler: async (ctx, { conversationId, when, at, recordId, values, model, costUsd }) => {
		const c = await ctx.db.get(conversationId);
		if (!c) return;
		await recordUsage(ctx, { workspaceId: c.workspaceId, kind: "fields", model, costUsd });
		if (c.fillAt?.[when] === at) await ctx.db.patch(c._id, { fillAt: { ...c.fillAt, [when]: undefined } });
		const record = await ctx.db.get(recordId);
		if (!record || record.archived || c.recordId !== recordId) return;
		const fields = await fieldsOf(ctx, record.typeId);
		const currency = await currencyOf(ctx, record.workspaceId);
		const next: Record<string, FieldValue> = {};
		for (const field of fields) {
			if (field.archived || field.change || field.ai?.when !== when || !canFillWithAi(field.kind)) continue;
			const raw = values[field.key];
			if (raw === null || raw === undefined) continue;
			const checked = normalizeValue(toField(field), raw, "input", currency);
			if ("error" in checked || checked.value === null) continue;
			const value = fieldAiWrite(field.ai.mode, field.kind, record.values[field.key], checked.value);
			if (value === undefined) continue;
			if (field.ai.mode === "suggest") await suggest(ctx, record, field, value, conversationId);
			else next[field.key] = value;
		}
		if (Object.keys(next).length) await applyValues(ctx, { ai: { workspaceId: record.workspaceId, conversationId } }, record, fields, next);
	},
});

/** Keeps one suggestion per record and field: the newest. */
async function suggest(ctx: MutationCtx, record: Doc<"records">, field: Doc<"recordFields">, value: FieldValue, conversationId: Id<"inboxConversations">) {
	const old = (await ctx.db.query("fieldSuggestions").withIndex("by_record", (q) => q.eq("recordId", record._id)).collect()).find((s) => s.fieldId === field._id);
	if (old) await ctx.db.delete(old._id);
	await ctx.db.insert("fieldSuggestions", { workspaceId: record.workspaceId, recordId: record._id, fieldId: field._id, value, conversationId, at: Date.now() });
}

/** A record's suggestions, for someone who can see it: the field, what it would become (as people read it), and from where. */
export const suggestions = query({
	args: { recordId: v.id("records") },
	handler: async (ctx, { recordId }) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const record = await readable(ctx, member, recordId);
		if (!record) return [];
		const rows = await ctx.db.query("fieldSuggestions").withIndex("by_record", (q) => q.eq("recordId", recordId)).collect();
		const fields = await fieldsOf(ctx, record.typeId);
		return rows.flatMap((s) => {
			const field = fields.find((f) => f._id === s.fieldId && !f.archived);
			if (!field) return [];
			const shown = displayValues([toField(field)], { [field.key]: s.value })[field.key];
			return [{ id: s._id, fieldKey: field.key, label: field.label, value: String(shown ?? ""), conversationId: s.conversationId ?? null, at: s.at }];
		});
	},
});

async function readable(ctx: QueryCtx, member: Member, recordId: Id<"records">) {
	try {
		return await requireRecord(ctx, member, recordId);
	} catch {
		return null;
	}
}

/** Accepting writes the suggested value as the person who accepted it (they decided); dismissing drops it. */
export const decide = mutation({
	args: { id: v.id("fieldSuggestions"), accept: v.boolean() },
	handler: async (ctx, { id, accept }) => {
		const member = await requireMember(ctx);
		const s = await ctx.db.get(id);
		if (!s || s.workspaceId !== member.workspaceId) throw new ConvexError("That suggestion is gone.");
		if (accept) {
			const field = await ctx.db.get(s.fieldId);
			if (!field || field.archived) throw new ConvexError("That field is gone.");
			await updateRecord(ctx, { member }, s.recordId, { [field.key]: s.value });
		} else await requireRecord(ctx, member, s.recordId, "edit");
		await ctx.db.delete(id);
	},
});

/** For fields.create and fields.update. */
export const fieldAiArg = v.optional(v.union(fieldAi, v.null()));
