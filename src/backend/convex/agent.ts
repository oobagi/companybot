import {
	type AgentConfig,
	type ChatStore,
	type MemoryStore,
	type PluginCredentials,
	type PluginSession,
	PluginOAuth,
	type ReplyUsage,
	PLUGIN_CALL,
	addStep,
	calledPluginTool,
	buildToolSet,
	buildTurnInput,
	buildTurnPrompt,
	builtinTools,
	createResultStore,
	emptyUsage,
	findPlugin,
	gatewayCost,
	grantedPluginIds,
	isWidgetResult,
	isWidgetToolName,
	openPlugin,
} from "@companybot/core";
import { generateText, isStepCount, streamText } from "ai";
import type { FunctionReturnType } from "convex/server";
import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import { decrypt, encrypt } from "./crypto";
import { oauthRedirectUrl } from "./plugins";
import type { messagePart } from "./schema";

const SUMMARY_MODEL = "anthropic/claude-haiku-5.5";
/** Summarize once a session's context passes this many tokens (turns.startCompaction keeps a ~15k-token tail). */
const COMPACT_TOKENS = 40_000;
const FLUSH_MS = 200;
/** A plugin that doesn't connect this fast is skipped for the turn, not waited on. */
const PLUGIN_CONNECT_MS = 10_000;

/** Runs one agent turn (see turns.ts): streams the reply into the database, then starts the next queued turn. */
export const respond = internalAction({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const started = Date.now();
		const usage: TurnUsage = emptyUsage("");
		let error: string | undefined;
		let sessionId: Id<"agentSessions"> | undefined;
		try {
			sessionId = await runTurn(ctx, turnId, usage);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			// Failed replies still cost what their finished calls cost.
			await ctx.runMutation(internal.turns.finishReply, {
				turnId,
				error,
				usage: usage.steps > 0 ? { ...usage, durationMs: Date.now() - started } : undefined,
			});
		}
		if (!error && sessionId && usage.contextTokens > COMPACT_TOKENS) await compact(ctx, sessionId);
	},
});

/** Filled in as the reply streams, so a failed reply still reports what it used. */
type TurnUsage = ReplyUsage & { firstTokenMs?: number };

async function runTurn(ctx: ActionCtx, turnId: Id<"agentTurns">, usage: TurnUsage) {
	const turn = await ctx.runQuery(internal.turns.turnContext, { turnId });
	const plugins = await loadPlugins(ctx, turn.member.userId, turn.agent);
	try {
		await streamReply(ctx, turnId, turn, plugins, usage);
	} finally {
		await Promise.allSettled(plugins.sessions.map((s) => s.close()));
		await saveRefreshedTokens(ctx, plugins);
	}
	return turn.session.id;
}

type Turn = FunctionReturnType<typeof internal.turns.turnContext>;
type LoadedPlugins = {
	sessions: PluginSession[];
	unavailable: string[];
	/** OAuth sign-ins in use, to save if the SDK refreshed their tokens. */
	oauth: { connectionId: Id<"pluginConnections">; provider: PluginOAuth }[];
};

async function saveRefreshedTokens(ctx: ActionCtx, plugins: LoadedPlugins) {
	for (const { connectionId, provider } of plugins.oauth) {
		if (!provider.changed) continue;
		const credentials = await encrypt({ type: "oauth", oauth: provider.stored } satisfies PluginCredentials);
		await ctx.runMutation(internal.plugins.updateCredentials, { connectionId, credentials });
	}
}

/**
 * Connects to the plugins this agent's grants reach and this person may use.
 * A failing plugin is skipped and the agent is told, so one bad connection never
 * breaks the reply.
 */
async function loadPlugins(ctx: ActionCtx, userId: Id<"users">, agent: Pick<AgentConfig, "tools">): Promise<LoadedPlugins> {
	const pluginIds = grantedPluginIds(agent);
	const oauth: LoadedPlugins["oauth"] = [];
	if (pluginIds.length === 0) return { sessions: [], unavailable: [], oauth };
	const usable = await ctx.runQuery(internal.plugins.forTurn, { userId, pluginIds });
	const results = await Promise.all(
		usable.map(async ({ pluginId, connectionId, credentials }) => {
			const plugin = findPlugin(pluginId)!;
			try {
				const creds: PluginCredentials = credentials ? await decrypt(credentials) : { type: "none" };
				let authProvider: PluginOAuth | undefined;
				if (creds.type === "oauth" && connectionId) {
					authProvider = new PluginOAuth(creds.oauth, oauthRedirectUrl(), false);
					oauth.push({ connectionId, provider: authProvider });
				}
				const session = await openWithTimeout(openPlugin(plugin, { credentials: creds, authProvider }));
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
		oauth,
	};
}

/** Gives up after PLUGIN_CONNECT_MS. A session that connects later anyway is closed, not leaked. */
function openWithTimeout(opening: Promise<PluginSession>): Promise<PluginSession> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error("Timed out connecting."));
			opening.then((s) => s.close()).catch(() => {});
		}, PLUGIN_CONNECT_MS);
	});
	return Promise.race([opening, timeout]).finally(() => clearTimeout(timer));
}

async function streamReply(
	ctx: ActionCtx,
	turnId: Id<"agentTurns">,
	turn: Turn,
	plugins: LoadedPlugins,
	usage: TurnUsage,
) {
	const { agent, member, replyId } = turn;
	usage.model = agent.model;
	// Plugin tools sorted by id, so the tool list is identical every turn and caches.
	const pluginTools = plugins.sessions.flatMap((s) => s.tools).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const tools = buildToolSet(
		agent,
		{
			actor: { userId: member.userId, role: member.role },
			agentId: agent.id,
			memory: memoryStore(ctx, member.userId, agent.id, turn.memory === "team"),
			chat: chatStore(ctx, turnId),
			skills: turn.skills,
			results: createResultStore(),
		},
		[...builtinTools, ...pluginTools],
		plugins.sessions.map((s) => ({ ...s.plugin, instructions: s.instructions })),
	);

	// Stored before the call: later turns replay this exact text, so the cache keeps hitting.
	const connected = plugins.sessions.flatMap(({ plugin }) => {
		const entry = findPlugin(plugin.id);
		return entry ? [{ name: entry.name, description: entry.description }] : [];
	});
	const prompt = buildTurnPrompt({ ...turn, agentId: agent.id, plugins: { connected, unavailable: plugins.unavailable } });
	await ctx.runMutation(internal.turns.savePrompt, { turnId, prompt });
	const input = buildTurnInput({ agent, skills: turn.skills, session: turn.session, prompt });

	const started = Date.now();
	const result = streamText({
		model: agent.model,
		instructions: input.instructions,
		messages: input.messages,
		tools,
		// Room for plugins_search + plugins_call + a widget + the answer.
		stopWhen: isStepCount(10),
		headers: { "x-session-affinity": turn.session.id },
		providerOptions: { gateway: { caching: "auto" } },
	});

	// Stream into the reply as ordered parts; clients see it live through their query.
	// Widget tools become widget parts; their tool activity isn't shown.
	const parts: Infer<typeof messagePart>[] = [];
	let lastFlush = 0;
	const text = () => parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
	const flush = () => ctx.runMutation(internal.turns.updateReply, { replyId, text: text(), parts });
	const setTool = (id: string, name: string, status: "running" | "done" | "error") => {
		const existing = parts.find((p) => p.type === "tool" && p.id === id);
		if (existing?.type === "tool") existing.status = status;
		else parts.push({ type: "tool", id, name, status });
	};

	for await (const part of result.stream) {
		if (part.type === "text-delta") {
			usage.firstTokenMs ??= Date.now() - started;
			const last = parts.at(-1);
			if (last?.type === "text") last.text += part.text;
			else parts.push({ type: "text", text: part.text });
		} else if (part.type === "tool-call") {
			// A plugins_call shows as the tool it ran.
			const name = part.toolName === PLUGIN_CALL ? (calledPluginTool(part.input) ?? part.toolName) : part.toolName;
			if (!isWidgetToolName(part.toolName)) setTool(part.toolCallId, name, "running");
		} else if (part.type === "tool-result") {
			if (isWidgetToolName(part.toolName)) {
				if (isWidgetResult(part.output)) parts.push({ type: "widget", id: part.toolCallId, widget: part.output.widget });
			} else setTool(part.toolCallId, part.toolName, "done");
		} else if (part.type === "tool-error") {
			if (!isWidgetToolName(part.toolName)) setTool(part.toolCallId, part.toolName, "error");
		} else if (part.type === "finish-step") {
			addStep(usage, part.usage, part.providerMetadata);
			continue;
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
 * call re-reads the person's role, so permission changes apply mid-reply. In chats
 * with 2+ people (`teamOnly`), the backend refuses personal memories.
 */
function memoryStore(ctx: ActionCtx, userId: Id<"users">, agentId: Id<"agents">, teamOnly: boolean): MemoryStore {
	const who = { userId, agentId, teamOnly };
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

/** Chats as the turn's person sees them; turns.ts re-checks access on every call. */
function chatStore(ctx: ActionCtx, turnId: Id<"agentTurns">): ChatStore {
	return {
		react: (emoji) => ctx.runMutation(internal.turns.reactFor, { turnId, emoji }),
		read: (input) => ctx.runQuery(internal.turns.readFor, { turnId, ...input }),
		search: (input) => ctx.runQuery(internal.turns.searchFor, { turnId, ...input }),
	};
}

/** Folds a session's older turns into its summary so context stays small. The UI still shows everything. */
async function compact(ctx: ActionCtx, sessionId: Id<"agentSessions">) {
	const input = await ctx.runMutation(internal.turns.startCompaction, { sessionId });
	if (!input) return;
	let result: { summary: string; upTo: number; costUsd: number } | undefined;
	try {
		const transcript = input.turns.map((t) => `Sent to you:\n${t.prompt}\n\nYou replied:\n${t.reply}`).join("\n\n---\n\n");
		const { text, providerMetadata } = await generateText({
			model: SUMMARY_MODEL,
			instructions:
				"Merge the previous summary and the new transcript into one short summary. Keep facts, decisions, preferences, open tasks, and who said what. Drop small talk. Plain bullet points.",
			headers: { "x-session-affinity": sessionId },
			providerOptions: { gateway: { caching: "auto" } },
			prompt: `Previous summary:\n${input.summary ?? "(none)"}\n\nNew transcript:\n${transcript}`,
		});
		result = { summary: text, upTo: input.upTo, costUsd: gatewayCost(providerMetadata) };
	} finally {
		await ctx.runMutation(internal.turns.finishCompaction, { sessionId, result });
	}
}
