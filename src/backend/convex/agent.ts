import {
	type AgentConfig,
	type MemoryStore,
	type PluginCredentials,
	type PluginSession,
	buildToolSet,
	builtinTools,
	findPlugin,
	grantedPluginIds,
	isGranted,
	isWidgetResult,
	openPlugin,
	platformGuide,
	skillsIndex,
} from "@companybot/core";
import { generateText, isStepCount, streamText } from "ai";
import type { FunctionReturnType } from "convex/server";
import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import { decrypt } from "./crypto";
import type { messagePart } from "./schema";

const SUMMARY_MODEL = "anthropic/claude-haiku-5.5";
/** Summarize once this many messages pile up past the summary, keeping the newest KEEP verbatim. */
const COMPACT_TRIGGER = 40;
const COMPACT_KEEP = 20;
const FLUSH_MS = 200;
/** A plugin that doesn't connect this fast is skipped for the turn, not waited on. */
const PLUGIN_CONNECT_MS = 10_000;

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
	const plugins = await loadPlugins(ctx, turn.member.userId, turn.agent);
	try {
		await streamReply(ctx, turn, replyId, plugins);
	} finally {
		await Promise.allSettled(plugins.sessions.map((s) => s.close()));
	}
}

type Turn = FunctionReturnType<typeof internal.chat.turnContext>;
type LoadedPlugins = { sessions: PluginSession[]; unavailable: string[] };

/**
 * Connects to the plugins this agent's grants reach and this person may use.
 * A failing plugin is skipped and the agent is told, so one bad connection never
 * breaks the reply.
 */
async function loadPlugins(ctx: ActionCtx, userId: Id<"users">, agent: Pick<AgentConfig, "tools">): Promise<LoadedPlugins> {
	const pluginIds = grantedPluginIds(agent);
	if (pluginIds.length === 0) return { sessions: [], unavailable: [] };
	const usable = await ctx.runQuery(internal.plugins.forTurn, { userId, pluginIds });
	const results = await Promise.all(
		usable.map(async ({ pluginId, connectionId, credentials }) => {
			const plugin = findPlugin(pluginId)!;
			try {
				const creds: PluginCredentials = credentials ? await decrypt(credentials) : { type: "none" };
				const session = await withTimeout(openPlugin(plugin, { credentials: creds }), PLUGIN_CONNECT_MS);
				if (connectionId) await ctx.runMutation(internal.plugins.setConnectionError, { connectionId });
				return { session };
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				if (connectionId) await ctx.runMutation(internal.plugins.setConnectionError, { connectionId, error: message });
				return { unavailable: plugin.name };
			}
		}),
	);
	return {
		sessions: results.flatMap((r) => (r.session ? [r.session] : [])),
		unavailable: results.flatMap((r) => (r.unavailable ? [r.unavailable] : [])),
	};
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Timed out connecting.")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function streamReply(ctx: ActionCtx, turn: Turn, replyId: Id<"messages">, plugins: LoadedPlugins) {
	const { agent, member } = turn;
	const tools = buildToolSet(
		agent,
		{
			actor: { userId: member.userId, role: member.role },
			agentId: agent.id,
			memory: memoryStore(ctx, member.userId, agent.id),
			skills: turn.skills,
		},
		[...builtinTools, ...plugins.sessions.flatMap((s) => s.tools)],
	);

	const instructions = [
		agent.instructions,
		platformGuide(agent),
		`You're talking with ${turn.name} <${turn.email}>, a workspace ${member.role}.`,
		isGranted(agent.tools, "skills.load") && skillsIndex(turn.skills),
		plugins.unavailable.length > 0 &&
			`These connected services are unavailable this turn, so you can't use them: ${plugins.unavailable.join(", ")}.`,
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

	// Stream into the reply as ordered parts; clients see it live through their query.
	// Widget tools become widget parts; their tool activity isn't shown.
	const parts: Infer<typeof messagePart>[] = [];
	let lastFlush = 0;
	const text = () => parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
	const flush = () => ctx.runMutation(internal.chat.updateReply, { replyId, text: text(), parts });
	const isWidgetTool = (name: string) => name.startsWith("widgets_");
	const setTool = (id: string, name: string, status: "running" | "done" | "error") => {
		const existing = parts.find((p) => p.type === "tool" && p.id === id);
		if (existing?.type === "tool") existing.status = status;
		else parts.push({ type: "tool", id, name, status });
	};

	for await (const part of result.stream) {
		if (part.type === "text-delta") {
			const last = parts.at(-1);
			if (last?.type === "text") last.text += part.text;
			else parts.push({ type: "text", text: part.text });
		} else if (part.type === "tool-call") {
			if (!isWidgetTool(part.toolName)) setTool(part.toolCallId, part.toolName, "running");
		} else if (part.type === "tool-result") {
			if (isWidgetTool(part.toolName)) {
				if (isWidgetResult(part.output)) parts.push({ type: "widget", id: part.toolCallId, widget: part.output.widget });
			} else setTool(part.toolCallId, part.toolName, "done");
		} else if (part.type === "tool-error") {
			if (!isWidgetTool(part.toolName)) setTool(part.toolCallId, part.toolName, "error");
		} else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
		else continue;
		if (Date.now() - lastFlush > FLUSH_MS) {
			lastFlush = Date.now();
			await flush();
		}
	}
	await flush();
}

/**
 * This agent's memory, routed through the same permission checks as the app. Each
 * call re-reads the person's role, so permission changes apply mid-reply.
 */
function memoryStore(ctx: ActionCtx, userId: Id<"users">, agentId: Id<"agents">): MemoryStore {
	const who = { userId, agentId };
	return {
		list: () => ctx.runQuery(internal.memory.listFor, who),
		create: (_actor, { scope, content }) => ctx.runMutation(internal.memory.createFor, { ...who, scope, content }),
		update: (_actor, id, content) =>
			ctx.runMutation(internal.memory.updateFor, { ...who, id: id as Id<"memories">, content }),
		remove: async (_actor, id) => {
			await ctx.runMutation(internal.memory.removeFor, { ...who, id: id as Id<"memories"> });
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
