import { type MemoryStore, buildToolSet, defaultAgents, skillsIndex } from "@companybot/core";
import { generateText, isStepCount, streamText } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import type { Member } from "./lib";

const SUMMARY_MODEL = "anthropic/claude-haiku-5.5";
/** Summarize once this many messages pile up past the summary, keeping the newest KEEP verbatim. */
const COMPACT_TRIGGER = 40;
const COMPACT_KEEP = 20;
const FLUSH_MS = 200;

type ToolStatus = { id: string; name: string; status: "running" | "done" | "error" };

export const respond = internalAction({
	args: { conversationId: v.id("conversations"), replyId: v.id("messages") },
	handler: async (ctx, { conversationId, replyId }) => {
		let error: string | undefined;
		try {
			await runTurn(ctx, conversationId, replyId);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			await ctx.runMutation(internal.chat.finishReply, { conversationId, replyId, error });
		}
		if (!error) await compact(ctx, conversationId);
	},
});

async function runTurn(ctx: ActionCtx, conversationId: Id<"conversations">, replyId: Id<"messages">) {
	const turn = await ctx.runQuery(internal.chat.turnContext, { conversationId, replyId });
	const agent = defaultAgents.find((a) => a.id === turn.agentId);
	if (!agent) throw new Error(`Unknown agent: ${turn.agentId}`);

	const actor = { userId: turn.member.userId, role: turn.member.role };
	const tools = buildToolSet(agent, {
		actor,
		agentId: agent.id,
		memory: memoryStore(ctx, turn.member),
		skills: turn.skills,
	});

	const instructions = [
		agent.instructions,
		`You're talking with ${turn.email} (${turn.member.role}).`,
		agent.tools.includes("skills.load") && skillsIndex(turn.skills),
		turn.summary && `Summary of your earlier conversation with them:\n${turn.summary}`,
	]
		.filter(Boolean)
		.join("\n\n");

	const result = streamText({
		model: agent.model,
		instructions,
		messages: turn.history.map((m) => ({ role: m.role, content: m.text })),
		tools,
		stopWhen: isStepCount(5),
	});

	// Stream into the reply message; clients see it live through their query.
	let text = "";
	const toolsUsed: ToolStatus[] = [];
	let lastFlush = 0;
	const flush = () => ctx.runMutation(internal.chat.updateReply, { replyId, text, tools: toolsUsed });
	const setTool = (id: string, name: string, status: ToolStatus["status"]) => {
		const existing = toolsUsed.find((t) => t.id === id);
		if (existing) existing.status = status;
		else toolsUsed.push({ id, name, status });
	};

	for await (const part of result.stream) {
		if (part.type === "text-delta") text += part.text;
		else if (part.type === "tool-call") setTool(part.toolCallId, part.toolName, "running");
		else if (part.type === "tool-result") setTool(part.toolCallId, part.toolName, "done");
		else if (part.type === "tool-error") setTool(part.toolCallId, part.toolName, "error");
		else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
		else continue;
		if (Date.now() - lastFlush > FLUSH_MS) {
			lastFlush = Date.now();
			await flush();
		}
	}
	await flush();
}

/** Memory access for tools, routed through the same permission checks as the app. */
function memoryStore(ctx: ActionCtx, member: Member): MemoryStore {
	return {
		list: () => ctx.runQuery(internal.memory.listFor, { member }),
		create: (_actor, { scope, content }) => ctx.runMutation(internal.memory.createFor, { member, scope, content }),
		update: (_actor, id, content) =>
			ctx.runMutation(internal.memory.updateFor, { member, id: id as Id<"memories">, content }),
		remove: async (_actor, id) => {
			await ctx.runMutation(internal.memory.removeFor, { member, id: id as Id<"memories"> });
		},
	};
}

/** Folds older messages into a running summary so context stays small. The UI still shows everything. */
async function compact(ctx: ActionCtx, conversationId: Id<"conversations">) {
	const input = await ctx.runQuery(internal.chat.compactionInput, {
		conversationId,
		keep: COMPACT_KEEP,
		trigger: COMPACT_TRIGGER,
	});
	if (!input) return;
	const transcript = input.messages.map((m) => `${m.role === "user" ? "Person" : "Agent"}: ${m.text}`).join("\n");
	const { text } = await generateText({
		model: SUMMARY_MODEL,
		instructions:
			"Merge the previous summary and the new transcript into one short summary. Keep facts, decisions, preferences, and open tasks. Drop small talk. Plain bullet points.",
		prompt: `Previous summary:\n${input.summary ?? "(none)"}\n\nNew transcript:\n${transcript}`,
	});
	await ctx.runMutation(internal.chat.saveSummary, { conversationId, summary: text, upTo: input.upTo });
}
