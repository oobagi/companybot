import {
	type AgentConfig,
	type ApprovalOutcome,
	type ToolContext,
	type ToolDef,
	type ChatStore,
	type LoggedCall,
	type MemoryStore,
	type PageStore,
	type RecordStore,
	type ConnectorCredentials,
	type ConnectorSession,
	ConnectorOAuth,
	type ReplyUsage,
	CONNECTOR_CALL,
	actionOf,
	addStep,
	callEnd,
	calledConnectorTool,
	callLabel,
	clipJson,
	describeCall,
	buildToolSet,
	buildTurnInput,
	buildTurnPrompt,
	builtinTools,
	canonicalJson,
	createResultStore,
	emptyUsage,
	findConnector,
	gatewayCost,
	grantedConnectorIds,
	isWidgetResult,
	isWidgetToolName,
	agentStopWhen,
	openConnector,
	resolveTools,
	deniedReason,
	toolApprovalPolicy,
	toolRisk,
} from "@companybot/core";
import { generateText, streamText } from "ai";
import type { FunctionReturnType } from "convex/server";
import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { type ActionCtx, internalAction } from "./_generated/server";
import { action } from "./functions";
import { decrypt, encrypt } from "./crypto";
import { oauthRedirectUrl } from "./connectors";
import type { messagePart } from "./schema";

const SUMMARY_MODEL = "anthropic/claude-haiku-5.5";
/** Summarize once a session's context passes this many tokens (turns.startCompaction keeps a ~15k-token tail). */
const COMPACT_TOKENS = 40_000;
const FLUSH_MS = 200;
/** A connector that doesn't connect this fast is skipped for the turn, not waited on. */
const CONNECTOR_CONNECT_MS = 10_000;

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
	const connectors = await loadConnectors(ctx, turn.member, turn.agent);
	await saveTools(ctx, turn.member.workspaceId, connectors);
	try {
		await streamReply(ctx, turnId, turn, connectors, usage);
	} finally {
		await Promise.allSettled(connectors.sessions.map((s) => s.close()));
		await saveRefreshedTokens(ctx, connectors);
	}
	return turn.session.id;
}

type Turn = FunctionReturnType<typeof internal.turns.turnContext>;
type LoadedConnectors = {
	sessions: ConnectorSession[];
	unavailable: string[];
	/** OAuth sign-ins in use, to save if the SDK refreshed their tokens. */
	oauth: { connectionId: Id<"connectorConnections">; provider: ConnectorOAuth }[];
	/** The install each connector was loaded under, by connector id. */
	installs: Record<string, Id<"connectorInstalls">>;
};

/**
 * Lists a connector's actions now, through your connection, so its page can show them
 * before any agent has used it.
 */
export const refreshTools = action({
	args: { connectorId: v.string() },
	handler: async (ctx, { connectorId }) => {
		const userId = await getAuthUserId(ctx);
		const workspaceId = userId && (await ctx.runQuery(internal.permissions.workspaceOf, { userId, workspaceId: ctx.workspaceId }));
		if (!userId || !workspaceId) throw new ConvexError("Sign in to a workspace first.");
		const connectors = await loadConnectors(ctx, { userId, workspaceId }, { tools: [`${connectorId}.*`] });
		try {
			if (connectors.unavailable.length > 0) throw new ConvexError(`Couldn't reach ${connectors.unavailable[0]}.`);
			await saveTools(ctx, workspaceId, connectors);
		} finally {
			await Promise.allSettled(connectors.sessions.map((s) => s.close()));
			await saveRefreshedTokens(ctx, connectors);
		}
	},
});

/** Keeps each connector's listed actions current for settings (connectorTools.saveTools; display only). */
async function saveTools(ctx: ActionCtx, workspaceId: Id<"workspaces">, connectors: LoadedConnectors) {
	for (const s of connectors.sessions) {
		const tools = s.tools.map((t) => ({
			name: t.id.slice(s.connector.id.length + 1),
			...(t.title && { title: t.title }),
			description: t.description,
			risk: toolRisk(t),
		}));
		await ctx.runMutation(internal.connectorTools.saveTools, { workspaceId, connectorId: s.connector.id, installId: connectors.installs[s.connector.id]!, tools });
	}
}

async function saveRefreshedTokens(ctx: ActionCtx, connectors: LoadedConnectors) {
	for (const { connectionId, provider } of connectors.oauth) {
		if (!provider.changed) continue;
		const credentials = await encrypt({ type: "oauth", oauth: provider.stored } satisfies ConnectorCredentials);
		await ctx.runMutation(internal.connectors.updateCredentials, { connectionId, credentials });
	}
}

/**
 * Connects to the connectors this agent's grants reach and this person may use.
 * A failing connector is skipped and the agent is told, so one bad connection never
 * breaks the reply.
 */
async function loadConnectors(
	ctx: ActionCtx,
	{ userId, workspaceId }: { userId: Id<"users">; workspaceId: Id<"workspaces"> },
	agent: Pick<AgentConfig, "tools">,
): Promise<LoadedConnectors> {
	const connectorIds = grantedConnectorIds(agent);
	const oauth: LoadedConnectors["oauth"] = [];
	if (connectorIds.length === 0) return { sessions: [], unavailable: [], oauth, installs: {} };
	const usable = await ctx.runQuery(internal.connectors.forTurn, { userId, workspaceId, connectorIds });
	const results = await Promise.all(
		usable.map(async ({ connectorId, connectionId, credentials }) => {
			const connector = findConnector(connectorId)!;
			try {
				const creds: ConnectorCredentials = credentials ? await decrypt(credentials) : { type: "none" };
				let authProvider: ConnectorOAuth | undefined;
				if (creds.type === "oauth" && connectionId) {
					authProvider = new ConnectorOAuth(creds.oauth, oauthRedirectUrl(), false);
					oauth.push({ connectionId, provider: authProvider });
				}
				const opened = await openWithTimeout(openConnector(connector, { credentials: creds, authProvider }));
				if (connectionId) await ctx.runMutation(internal.connectors.setConnectionError, { connectionId });
				// Access is read fresh before every call, so a role change or disconnect applies mid-reply.
				const stillAllowed = async () =>
					(await ctx.runQuery(internal.connectors.forTurn, { userId, workspaceId, connectorIds: [connectorId] }))[0]?.connectionId === connectionId;
				const session: ConnectorSession = {
					...opened,
					tools: opened.tools.map((tool) => ({
						...tool,
						execute: async (input, toolCtx) =>
							(await stillAllowed())
								? tool.execute(input, toolCtx)
								: { error: `${connector.name} isn't available to this person anymore, so this didn't run.` },
					})),
				};
				return { session };
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				if (connectionId) await ctx.runMutation(internal.connectors.setConnectionError, { connectionId, error: message });
				return { unavailable: connector.name };
			}
		}),
	);
	return {
		sessions: results.flatMap((r) => (r.session ? [r.session] : [])),
		unavailable: results.flatMap((r) => (r.unavailable ? [r.unavailable] : [])),
		oauth,
		installs: Object.fromEntries(usable.map((u) => [u.connectorId, u.installId])),
	};
}

/** Gives up after CONNECTOR_CONNECT_MS. A session that connects later anyway is closed, not leaked. */
function openWithTimeout(opening: Promise<ConnectorSession>): Promise<ConnectorSession> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error("Timed out connecting."));
			opening.then((s) => s.close()).catch(() => {});
		}, CONNECTOR_CONNECT_MS);
	});
	return Promise.race([opening, timeout]).finally(() => clearTimeout(timer));
}

async function streamReply(
	ctx: ActionCtx,
	turnId: Id<"agentTurns">,
	turn: Turn,
	connectors: LoadedConnectors,
	usage: TurnUsage,
) {
	const { agent, member, replyId } = turn;
	usage.model = agent.model;
	// Connector tools sorted by id, so the tool list is identical every turn and caches.
	const connectorTools = connectors.sessions.flatMap((s) => s.tools).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const available = [...builtinTools, ...connectorTools];
	const services = connectors.sessions.map((s) => s.connector);
	const toolCtx: ToolContext = {
		actor: { userId: member.userId, role: member.role },
		timeZone: turn.actor.timeZone,
		agentId: agent.id,
		memory: memoryStore(ctx, turnId),
		chat: chatStore(ctx, turnId),
		manage: { run: (tool, input) => ctx.runMutation(internal.manageTools.runFor, { turnId, tool, input }) },
		skills: {
			list: turn.skills,
			create: (config) => ctx.runMutation(internal.skills.createFor, { turnId, config }),
		},
		automations: {
			list: () => ctx.runQuery(internal.automationTools.listFor, { turnId }),
			create: (input) => ctx.runMutation(internal.automationTools.createFor, { turnId, input }),
			setMine: (input) => ctx.runMutation(internal.automationTools.setMineFor, { turnId, ...input }),
		},
		records: recordStore(ctx, turnId),
		pages: pageStore(ctx, turnId),
		results: createResultStore(),
	};
	const tools = buildToolSet(
		agent,
		toolCtx,
		available,
		connectors.sessions.map((s) => ({ ...s.connector, instructions: s.instructions })),
	);
	/** What this person can run now; calls that ask are held (approvals.ts). */
	const usable = resolveTools(agent, toolCtx.actor, available);
	// Each call is decided from the rules in force right then (permissions.check), never cached.
	// Remembered per call so the activity log says how it was allowed, or why it was blocked.
	const allowedCalls = new Map<string, FunctionReturnType<typeof internal.permissions.check>["allowed"] & {}>();
	const deniedCalls = new Map<string, string>();
	const check = async (t: ToolDef, callId: string) => {
		const { decision, allowed } = await ctx.runQuery(internal.permissions.check, { turnId, action: t.id, risk: toolRisk(t) });
		if (allowed) allowedCalls.set(callId, allowed);
		if (decision.type === "deny") deniedCalls.set(callId, deniedReason(decision.by, t.id));
		return decision;
	};

	// Stream into the reply as ordered parts; clients see it live through their query.
	// Widget tools become widget parts; their tool activity isn't shown.
	const parts: Infer<typeof messagePart>[] = [];
	let lastFlush = 0;
	const text = () => parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
	const flush = () => ctx.runMutation(internal.turns.updateReply, { replyId, text: text(), parts });
	// Labels say what each call did ("Created deal Reroof main warehouse"): from its input while
	// it runs, and its result once done. Stored with the reply; replays never include them.
	const callInputs = new Map<string, unknown>();
	const setTool = (id: string, name: string, status: "running" | "done" | "error", call?: { input: unknown; output?: unknown }) => {
		if (call) callInputs.set(id, call.input);
		const existing = parts.find((p) => p.type === "tool" && p.id === id);
		const label = (toolName: string) => callLabel(toolName, available, services, { input: callInputs.get(id), output: call?.output });
		if (existing?.type === "tool") {
			existing.status = status;
			existing.label = label(existing.name);
		} else parts.push({ type: "tool", id, name, label: label(name), status });
	};

	// A turn after an approval runs the approved call first, so its outcome goes in the prompt.
	const approval = turn.approval && (await runApproval(ctx, turnId, turn.approval, usable, toolCtx, setTool));

	// Stored before the call: later turns replay this exact text, so the cache keeps hitting.
	const connected = connectors.sessions.flatMap(({ connector }) => {
		const entry = findConnector(connector.id);
		return entry ? [{ name: entry.name, description: entry.description }] : [];
	});
	const promptInput = {
		...turn,
		agentId: agent.id,
		connectors: { connected, unavailable: connectors.unavailable },
		approval: approval ?? undefined,
	};
	const prompt = buildTurnPrompt(promptInput);
	// Later turns replay what's stored. They can act for someone else, so an approved call's
	// result stays out of it (only its approver may see it); this turn alone gets it.
	await ctx.runMutation(internal.turns.savePrompt, { turnId, prompt: approval ? buildTurnPrompt({ ...promptInput, forReplay: true }) : prompt });
	const input = buildTurnInput({ agent, skills: turn.skills, session: turn.session, prompt, available: usable });

	const started = Date.now();
	const result = streamText({
		model: agent.model,
		instructions: input.instructions,
		messages: input.messages,
		tools,
		stopWhen: agentStopWhen,
		headers: { "x-session-affinity": turn.session.id },
		providerOptions: { gateway: { caching: "auto" } },
		// Calls that need approval stop the run there, unexecuted; we hold them below.
		toolApproval: toolApprovalPolicy(usable, check),
	});

	// Each tool call goes to the activity log once it finishes (activity.ts).
	const calls = new Map<string, LoggedCall>();
	const logCall = async (callId: string, end: { output: unknown } | { error: string }) => {
		const call = calls.get(callId);
		if (!call) return;
		calls.delete(callId);
		await ctx.runMutation(internal.activity.log, {
			turnId,
			callId,
			tool: call.tool,
			changes: call.changes,
			input: clipJson(call.input),
			...("output" in end ? { output: clipJson(end.output) } : { error: end.error }),
			allowed: allowedCalls.get(callId),
		});
	};

	try {
		for await (const part of result.stream) {
			if (part.type === "text-delta") {
				usage.firstTokenMs ??= Date.now() - started;
				const last = parts.at(-1);
				if (last?.type === "text") last.text += part.text;
				else parts.push({ type: "text", text: part.text });
			} else if (part.type === "tool-call") {
				// A connectors_call shows as the tool it ran.
				const name = part.toolName === CONNECTOR_CALL ? (calledConnectorTool(part.input) ?? part.toolName) : part.toolName;
				if (!isWidgetToolName(part.toolName)) setTool(part.toolCallId, name, "running", { input: part.input });
				const call = describeCall(part.toolName, part.input, available);
				if (call) calls.set(part.toolCallId, call);
			} else if (part.type === "tool-result") {
				const end = callEnd(part.output);
				if (isWidgetToolName(part.toolName)) {
					if (isWidgetResult(part.output)) parts.push({ type: "widget", id: part.toolCallId, widget: part.output.widget });
				} else setTool(part.toolCallId, part.toolName, "error" in end ? "error" : "done", { input: callInputs.get(part.toolCallId), ...("output" in end && { output: end.output }) });
				await logCall(part.toolCallId, end);
			} else if (part.type === "tool-error") {
				if (!isWidgetToolName(part.toolName)) setTool(part.toolCallId, part.toolName, "error");
				await logCall(part.toolCallId, { error: part.error instanceof Error ? part.error.message : String(part.error) });
			} else if (part.type === "tool-output-denied") {
				// Blocked by a Never or an owner's lock: it didn't run, and the model was told why.
				setTool(part.toolCallId, part.toolName, "error");
				await logCall(part.toolCallId, { error: deniedCalls.get(part.toolCallId) ?? "Blocked." });
			} else if (part.type === "tool-approval-request") {
				// Blocked calls come through here too, already answered; they're handled above.
				if (part.isAutomatic) continue;
				// Held, not run: save the exact call and show a card in its place. Logged only if it runs later.
				const { toolCallId, toolName, input } = part.toolCall;
				calls.delete(toolCallId);
				const held = await actionOf(toolName, input, usable);
				const at = parts.findIndex((p) => p.type === "tool" && p.id === toolCallId);
				if (held) {
					const approvalId = await ctx.runMutation(internal.approvals.request, {
						turnId,
						callId: toolCallId,
						tool: held.tool.id,
						input: canonicalJson(held.input),
						risk: toolRisk(held.tool),
					});
					const card = { type: "approval" as const, id: toolCallId, approvalId, tool: held.tool.id };
					if (at >= 0) parts[at] = card;
					else parts.push(card);
				} else setTool(toolCallId, toolName, "error");
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
	} finally {
		for (const callId of [...calls.keys()]) await logCall(callId, { error: "The reply stopped before this finished." });
	}
	await flush();
}

/**
 * Runs the call a decision approved, exactly as stored (approvals.claim re-checks the
 * hash), as this turn's person with their access now. Denied calls don't run. Shows
 * up in this reply as a tool line and in the activity log, like any call.
 */
async function runApproval(
	ctx: ActionCtx,
	turnId: Id<"agentTurns">,
	approval: NonNullable<Turn["approval"]>,
	usable: ToolDef[],
	toolCtx: ToolContext,
	setTool: (id: string, name: string, status: "running" | "done" | "error", call?: { input: unknown; output?: unknown }) => void,
): Promise<ApprovalOutcome | null> {
	const { id: approvalId, tool, by } = approval;
	if (approval.status === "denied") return { tool, by, decision: "denied" };
	const call = await ctx.runMutation(internal.approvals.claim, { approvalId, turnId });
	if (!call) return { tool, by, decision: "approved", error: "It didn't run: it was already handled, no longer matches what was approved, or was blocked since." };
	const callId = `approval-${approvalId}`;
	setTool(callId, tool, "running", { input: call.input });
	const t = usable.find((x) => x.id === call.tool);
	let end: { output: unknown } | { error: string };
	try {
		if (!t) throw new Error(`${tool} isn't available to ${by} right now (disconnected, or access changed).`);
		end = callEnd(await t.execute(call.input, toolCtx));
	} catch (e) {
		end = { error: e instanceof Error ? e.message : String(e) };
	}
	setTool(callId, tool, "error" in end ? "error" : "done", { input: call.input, ...("output" in end && { output: end.output }) });
	const result = "output" in end ? clipJson(end.output) : undefined;
	const error = "error" in end ? end.error : undefined;
	await ctx.runMutation(internal.approvals.finish, { approvalId, result, error });
	const allowed = { how: approval.always ? ("always" as const) : ("once" as const), by: approval.actorId, at: approval.decidedAt ?? Date.now() };
	await ctx.runMutation(internal.activity.log, { turnId, callId, tool, changes: true, input: clipJson(call.input), output: result, error, allowed });
	return { tool, by, decision: "approved", result, error };
}

/**
 * This agent's memory, routed through the same permission checks as the app. memory.ts
 * re-checks the turn, the person's role and the chat on every call, so permission changes
 * apply mid-reply, and refuses personal memories in chats with 2+ people.
 */
function memoryStore(ctx: ActionCtx, turnId: Id<"agentTurns">): MemoryStore {
	return {
		search: (query) => ctx.runQuery(internal.memory.searchFor, { turnId, query }),
		create: ({ scope, content }) => ctx.runMutation(internal.memory.createFor, { turnId, scope, content }),
		update: (id, content) => ctx.runMutation(internal.memory.updateFor, { turnId, id: id as Id<"memories">, content }),
		remove: async (id) => {
			await ctx.runMutation(internal.memory.removeFor, { turnId, id: id as Id<"memories"> });
		},
	};
}

/** Chats as the turn's person sees them; chatTools.ts re-checks access on every call. */
function chatStore(ctx: ActionCtx, turnId: Id<"agentTurns">): ChatStore {
	return {
		react: (emoji) => ctx.runMutation(internal.chatTools.reactFor, { turnId, emoji }),
		read: (input) => ctx.runQuery(internal.chatTools.readFor, { turnId, ...input }),
		search: (input) => ctx.runQuery(internal.chatTools.searchFor, { turnId, ...input }),
	};
}

/** Records as the turn's person may read and change them; recordTools.ts re-checks access on every call. */
function recordStore(ctx: ActionCtx, turnId: Id<"agentTurns">): RecordStore {
	return {
		types: () => ctx.runQuery(internal.recordTools.typesFor, { turnId }),
		find: (input) => ctx.runQuery(internal.recordTools.findFor, { turnId, input }),
		get: ({ id }) => ctx.runQuery(internal.recordTools.getFor, { turnId, id }),
		save: (input) => ctx.runMutation(internal.recordTools.saveFor, { turnId, input }),
		undo: ({ change }) => ctx.runMutation(internal.recordTools.undoFor, { turnId, change }),
		saveField: (input) => ctx.runMutation(internal.recordTools.saveFieldFor, { turnId, input }),
		saveDatabase: (input) => ctx.runMutation(internal.recordTools.saveDatabaseFor, { turnId, input }),
		views: ({ type }) => ctx.runQuery(internal.recordTools.viewsFor, { turnId, type }),
		saveView: (input) => ctx.runMutation(internal.recordTools.saveViewFor, { turnId, input }),
	};
}

/** Convert Markdown in Node; pageTools rechecks the acting person's access. */
function pageStore(ctx: ActionCtx, turnId: Id<"agentTurns">): PageStore {
	return {
		find: (input) => ctx.runQuery(internal.pageTools.findFor, { turnId, input }),
		async read(input) {
			const page = await ctx.runQuery(internal.pageTools.readFor, { turnId, ...input });
			if ("error" in page) return page;
			const { doc, ...rest } = page;
			return { ...rest, markdown: doc === null ? "" : await ctx.runAction(internal.pageMarkdown.toMarkdown, { doc }) };
		},
		write: async (input) =>
			ctx.runMutation(internal.pageTools.writeFor, {
				turnId,
				input,
				...(input.markdown !== undefined && { blocks: await ctx.runAction(internal.pageMarkdown.fromMarkdown, { markdown: input.markdown }) }),
			}),
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
