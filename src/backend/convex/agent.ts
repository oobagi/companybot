import {
	type AgentConfig,
	type ApprovalOutcome,
	type ToolContext,
	type ToolDef,
	type ChatStore,
	type LoggedCall,
	type MemoryStore,
	type PostDecision,
	type PageStore,
	type RecordStore,
	type ConnectorCredentials,
	type ConnectorSession,
	ConnectorOAuth,
	type ReplyUsage,
	type TurnImage,
	type WebClient,
	CONNECTOR_CALL,
	actionOf,
	addStep,
	callEnd,
	calledConnectorTool,
	callLabel,
	callOpens,
	clipJson,
	describeCall,
	buildToolSet,
	buildTurnInput,
	buildTurnPrompt,
	builtinTools,
	canonicalJson,
	cleanWhy,
	createResultStore,
	createWebTurn,
	emptyUsage,
	findConnector,
	gatewayCost,
	whyPrompt,
	grantedConnectorIds,
	isWidgetResult,
	isWidgetToolName,
	agentPrepareStep,
	agentStopAfter,
	openConnector,
	postDecision,
	responseOf,
	resolveTools,
	searchProvider,
	deniedReason,
	isImageType,
	manageFiles,
	toolApprovalPolicy,
	toolLine,
	toolRisk,
	THINKING_STEP,
} from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { type ModelMessage, Output, generateText, streamText } from "ai";
import type { FunctionReturnType } from "convex/server";
import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import { action } from "./functions";
import { oauthRedirectUrl } from "./connectors";
import { decrypt, encrypt } from "./crypto";
import type { messagePart } from "./schema";

const SUMMARY_MODEL = "anthropic/claude-haiku-5.5";
/** Summarize once a session's context passes this many tokens (turns.startCompaction keeps a ~15k-token tail). */
const COMPACT_TOKENS = 40_000;
const FLUSH_MS = 200;
/** How often a turn checks for Stop when it hasn't flushed lately (a long think streams reasoning, not text). */
const STOP_CHECK_MS = 1_000;
/**
 * How long into a reply it still starts its answer over to take in the person's new messages (turnStop).
 * No count: each restart takes in a whole burst (it waits for them to pause) and only redoes the writing
 * step, cached, so it's cheap. This is a safety net against something posting nonstop; past it, a message
 * that arrives while it writes waits for the follow-up.
 */
export const STEER_WINDOW_MS = 60_000;
/** A connector that doesn't connect this fast is skipped for the turn, not waited on. */
const CONNECTOR_CONNECT_MS = 10_000;

/** Runs one agent turn (see turns.ts): streams the reply into the database, then starts the next queued turn. */
export const respond = internalAction({
	args: { turnId: v.id("agentTurns") },
	handler: async (ctx, { turnId }) => {
		const started = Date.now();
		const usage: TurnUsage = emptyUsage("");
		let error: string | undefined;
		let ran: Awaited<ReturnType<typeof runTurn>> | undefined;
		const snapshot = () => ({ ...usage, durationMs: Date.now() - started });
		// Saved after every finished model call, so an action killed mid-turn (time limit, crash) keeps
		// what its calls cost. finishReply records only what's new since; a failed save is caught up there.
		const saveStep = () => ctx.runMutation(internal.turns.saveUsage, { turnId, usage: snapshot() }).catch(() => {});
		try {
			ran = await runTurn(ctx, turnId, usage, saveStep);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			// Failed replies still cost what their finished calls cost.
			await ctx.runMutation(internal.turns.finishReply, { turnId, error, usage: usage.steps > 0 ? snapshot() : undefined, ...(ran?.decision && { decision: ran.decision }) });
		}
		if (!error && ran && usage.contextTokens > COMPACT_TOKENS) await compact(ctx, ran.sessionId, turnId);
	},
});

/** Filled in as the reply streams, so a failed reply still reports what it used. */
type TurnUsage = ReplyUsage & { firstTokenMs?: number };

async function runTurn(ctx: ActionCtx, turnId: Id<"agentTurns">, usage: TurnUsage, saveStep: () => Promise<unknown>) {
	const turn = await ctx.runMutation(internal.turns.turnContext, { turnId });
	const connectors = await loadConnectors(ctx, turn.member, turn.agent, turnId);
	await saveTools(ctx, turn.member.workspaceId, connectors);
	try {
		const decision = await streamReply(ctx, turnId, turn, connectors, usage, saveStep);
		return { sessionId: turn.session.id, decision };
	} finally {
		await Promise.allSettled(connectors.sessions.map((s) => s.close()));
		await saveRefreshedTokens(ctx, connectors);
	}
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
	turnId?: Id<"agentTurns">,
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
					(turnId
						? await ctx.runMutation(internal.connectors.forCall, { turnId, connectorId })
						: (await ctx.runQuery(internal.connectors.forTurn, { userId, workspaceId, connectorIds: [connectorId] }))[0])?.connectionId === connectionId;
				// Personal servers can include account data in their instructions and tool descriptions too.
				if (turnId && connector.connection === "personal" && !(await stillAllowed())) return { unavailable: connector.name };
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
	saveStep: () => Promise<unknown>,
) {
	const { agent, member, replyId } = turn;
	usage.model = agent.model;
	// Connector tools sorted by id, so the tool list is identical every turn and caches.
	const connectorTools = connectors.sessions.flatMap((s) => s.tools).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const available = [...builtinTools, ...connectorTools];
	const services = connectors.sessions.map((s) => s.connector);
	const toolCtx: ToolContext = {
		actor: { userId: member.userId, roles: member.roles, owner: member.owner, permissions: member.permissions },
		timeZone: turn.actor.timeZone,
		agentId: agent.id,
		memory: memoryStore(ctx, turnId),
		chat: chatStore(ctx, turnId),
		manage: { run: (tool, input) => runManage(ctx, turnId, tool, input) },
		skills: {
			list: turn.skills,
			create: ({ audience, ...config }) => ctx.runMutation(internal.skills.createFor, { turnId, config, audience }),
		},
		automations: {
			list: () => ctx.runMutation(internal.automationTools.listFor, { turnId }),
			create: (input) => ctx.runMutation(internal.automationTools.createFor, { turnId, input }),
			setMine: (input) => ctx.runMutation(internal.automationTools.setMineFor, { turnId, ...input }),
		},
		wakeups: {
			create: (input) => ctx.runMutation(internal.wakeups.createFor, { turnId, input }),
			list: (input) => ctx.runMutation(internal.wakeups.listFor, { turnId, ...input }),
			cancel: (input) => ctx.runMutation(internal.wakeups.cancelFor, { turnId, ...input }),
		},
		records: recordStore(ctx, turnId),
		pages: pageStore(ctx, turnId),
		results: createResultStore(),
		// Links the person wrote (turns.ts `asked`) are the only ones web.fetch opens before searching.
		web: createWebTurn(webClient(ctx, turnId), turn.asked),
		// imageGen.ts checks the budget and edit files as this person, then attaches and records each picture.
		images: { generate: (request) => ctx.runAction(internal.imageGen.generateFor, { turnId, ...request }) },
	};
	const tools = buildToolSet(
		agent,
		toolCtx,
		available,
		connectors.sessions.map((s) => ({ ...s.connector, instructions: s.instructions })),
	);
	/** What this person can run now; calls that ask are held (approvals.ts). */
	const usable = resolveTools(agent, available);
	// Each call is decided from the rules in force right then (permissions.check), never cached.
	// Remembered per call so the activity log says how it was allowed, or why it was blocked.
	const allowedCalls = new Map<string, FunctionReturnType<typeof internal.permissions.check>["allowed"] & {}>();
	const deniedCalls = new Map<string, string>();
	/** Calls held in an automation's run: the model was told they're waiting, and the run goes on. */
	const heldCalls = new Set<string>();
	const check = async (t: ToolDef, callId: string) => {
		const { decision, allowed } = await ctx.runMutation(internal.permissions.check, { turnId, action: t.id, risk: toolRisk(t) });
		if (allowed) allowedCalls.set(callId, allowed);
		if (decision.type === "deny") deniedCalls.set(callId, deniedReason(decision, t.id));
		if (decision.type === "ask" && decision.waitFor) heldCalls.add(callId);
		return decision;
	};

	// Stream into the reply as ordered parts; clients see it live through their query.
	// Widget tools become widget parts; their tool activity isn't shown.
	const parts: Infer<typeof messagePart>[] = [];
	let lastFlush = 0;
	const text = () => parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
	// Stop (turns.stop) is seen on each flush, between flushes, and at each step (`stop`, set just before the model call).
	const flush = () => stop.hear(ctx.runMutation(internal.turns.updateReply, { turnId, text: text(), parts }));
	// The turn's step, for the line under the composer (turns.setStep): the newest call still running,
	// else "Thinking…" until its message starts (then it types, like a person). The same words as its tool lines; never its reasoning.
	// Written in order, and only when it changes.
	const stepCalls = new Map<string, string>();
	let writing = false;
	let shownStep: string | undefined;
	let stepWrites: Promise<unknown> = Promise.resolve();
	const showStep = () => {
		const label = [...stepCalls.values()].at(-1) ?? (writing ? undefined : THINKING_STEP);
		if (label === shownStep) return;
		shownStep = label;
		stepWrites = stepWrites.then(() => ctx.runMutation(internal.turns.setStep, { turnId, label })).catch(() => {});
	};
	showStep();

	// Labels say what each call did ("Created deal Reroof main warehouse"): from its input while
	// it runs, and its result once done. Stored with the reply; replays never include them.
	const callInputs = new Map<string, unknown>();
	const setTool = (id: string, name: string, status: "running" | "done" | "error", call?: { input: unknown; output?: unknown }) => {
		if (call) callInputs.set(id, call.input);
		const existing = parts.find((p) => p.type === "tool" && p.id === id);
		const label = callLabel(existing?.type === "tool" ? existing.name : name, available, services, { input: callInputs.get(id), output: call?.output });
		// A call that made a thread (chat.ask_agent's) opens it from its line.
		const opens = status === "done" ? callOpens(name, available, call?.output) : undefined;
		const link = opens && { opens: { chatId: opens.chatId as Id<"chats">, messageId: opens.messageId as Id<"chatMessages">, ...(opens.kind && { kind: opens.kind }) } };
		if (existing?.type === "tool") {
			existing.status = status;
			existing.label = label;
			if (link) existing.opens = link.opens;
		} else parts.push({ type: "tool", id, name, label, status, ...link });
		if (status === "running") stepCalls.set(id, toolLine(label, "running"));
		else stepCalls.delete(id);
		showStep();
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
		now: Date.now(),
		connectors: { connected, unavailable: connectors.unavailable },
		approval: approval ?? undefined,
	};
	const prompt = buildTurnPrompt(promptInput);
	// Later turns replay what's stored. They can act for someone else, so an approved call's
	// result stays out of it (only its approver may see it); this turn alone gets it.
	await ctx.runMutation(internal.turns.savePrompt, { turnId, prompt: approval ? buildTurnPrompt({ ...promptInput, forReplay: true }) : prompt });
	const input = buildTurnInput({ agent, skills: turn.skills, session: turn.session, prompt, available: usable, images: await loadImages(ctx, turn.images) });
	// Every turn ends with its decision (core postDecision): what it posts and reacts, the final step's
	// structured output, so tools still run first. Its text is that JSON; only `message` is shown.
	const output = Output.object({ schema: postDecision, name: "decision" });

	const started = Date.now();
	const stop = turnStop(ctx, turnId);
	/** The person's new messages here (turns.steer), taken into this turn; their links may be opened too. */
	const steer = async () => {
		const taken = await ctx.runMutation(internal.turns.steer, { turnId });
		if (!taken) return null;
		toolCtx.web.asked(taken.asked);
		return taken.note;
	};
	// What the newest step was sent: a run cut off to take in a message starts again from there.
	let sent: ModelMessage[] = input.messages;
	/** Steps this reply finished, over all its runs: the step limit is per reply. */
	let done = 0;
	const run = () =>
		streamText({
			model: agent.model,
			reasoning: agent.reasoning,
			instructions: input.instructions,
			messages: sent,
			tools,
			// Stopped mid-tool: the step's calls finish, and no step comes after them.
			stopWhen: [agentStopAfter(done), stop.atStep],
			abortSignal: stop.signal,
			// Each step after the first takes in what the person sent meanwhile; it still ends with its decision.
			prepareStep: agentPrepareStep(tools, toolCtx.web, { steer, done, sent: (m) => (sent = m) }),
			headers: { "x-session-affinity": turn.session.id },
			providerOptions: { gateway: { caching: "auto" } },
			// Calls that need approval stop the run there, unexecuted; we hold them below.
			toolApproval: toolApprovalPolicy(usable, check),
			output,
		});
	let result = run();

	/**
	 * The top of a held call's card, in the agent's words: what it will do and why. Same model,
	 * instructions and conversation as the turn, so it knows why, and the prefix stays cached.
	 * A failure just leaves the card with its plain ask.
	 */
	const explain = async (tool: string, callInput: string) => {
		try {
			const r = await generateText({
				model: agent.model,
				reasoning: "low",
				instructions: input.instructions,
				messages: [...input.messages, { role: "user", content: whyPrompt(tool, callInput) }],
				headers: { "x-session-affinity": turn.session.id },
				providerOptions: { gateway: { caching: "auto" } },
				maxOutputTokens: 400,
				abortSignal: AbortSignal.timeout(20_000),
			});
			usage.costUsd += gatewayCost(r.providerMetadata);
			return cleanWhy(r.text);
		} catch {
			return undefined;
		}
	};

	// Held, not run: save the exact call and show a card in its place. Logged only if it runs later.
	const hold = async (toolCallId: string, toolName: string, input: unknown) => {
		calls.delete(toolCallId);
		stepCalls.delete(toolCallId);
		showStep();
		const held = await actionOf(toolName, input, usable);
		const at = parts.findIndex((p) => p.type === "tool" && p.id === toolCallId);
		if (!held) return setTool(toolCallId, toolName, "error");
		const exact = canonicalJson(held.input);
		const why = await explain(held.tool.id, exact);
		const { approvalId, separate } = await ctx.runMutation(internal.approvals.request, {
			turnId,
			callId: toolCallId,
			tool: held.tool.id,
			input: exact,
			risk: toolRisk(held.tool),
			why,
		});
		if (separate) {
			if (at >= 0) parts.splice(at, 1);
			return;
		}
		const card = { type: "approval" as const, id: toolCallId, approvalId, tool: held.tool.id, ...(why && { why }) };
		if (at >= 0) parts[at] = card;
		else parts.push(card);
	};

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

	/** Where the current step's parts begin: a step cut off to take in a message loses what it wrote. */
	let stepStart = 0;
	// The message streams as the decision's JSON fills in: the SDK's partial output of the step's text
	// (what `partialOutputStream` emits), read in this loop so it lands in order with the tool lines.
	// It's the current step's only: a step that goes on to call tools wasn't the last, so its draft goes.
	const draft = { type: "text" as const, text: "" };
	let stepText = "";
	const dropDraft = () => {
		if (parts.includes(draft)) parts.splice(parts.indexOf(draft), 1);
		draft.text = "";
		stepText = "";
	};
	try {
		for (;;) {
			for await (const part of result.stream) {
				stop.saw(part);
				if (part.type === "start-step") {
					dropDraft();
					stepStart = parts.length;
					writing = false;
					showStep();
				} else if (part.type === "text-delta") {
					usage.firstTokenMs ??= Date.now() - started;
					stepText += part.text;
					const message = (await output.parsePartialOutput({ text: stepText }))?.partial?.message;
					if (typeof message !== "string" || message === draft.text) continue;
					draft.text = message;
					if (!parts.includes(draft)) parts.push(draft);
					if (!writing) {
						writing = true;
						showStep();
					}
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
					// Held in an automation's run: a card, while the run goes on. Otherwise blocked by a
					// Never or a workspace lock: it didn't run, and the model was told why.
					if (heldCalls.has(part.toolCallId)) await hold(part.toolCallId, part.toolName, callInputs.get(part.toolCallId));
					else {
						setTool(part.toolCallId, part.toolName, "error");
						await logCall(part.toolCallId, { error: deniedCalls.get(part.toolCallId) ?? "Blocked." });
					}
				} else if (part.type === "tool-approval-request") {
					// Blocked and held-while-going-on calls come through here too, already answered; they're handled above.
					if (!part.isAutomatic) await hold(part.toolCall.toolCallId, part.toolCall.toolName, part.toolCall.input);
				} else if (part.type === "finish-step") {
					done++;
					addStep(usage, part.usage, part.providerMetadata);
					await saveStep();
					continue;
				} else if (part.type === "error") {
					// Cut off on purpose (Stop, or a message to take in): not a failure.
					if (stop.signal.aborted) break;
					throw part.error instanceof Error ? part.error : new Error(String(part.error));
				} else continue;
				// The step is written before the next part, so it never lags behind the reply.
				await stepWrites;
				if (Date.now() - lastFlush > FLUSH_MS) {
					lastFlush = Date.now();
					await flush();
				}
			}
			// The person wrote while the model was writing its answer, with no step boundary left to add it at
			// (turnStop cut it off): what it wrote this step goes, and once they pause it starts again from what
			// that step was sent, plus everything they sent. Steps before it (tool calls, their results) stand
			// and aren't redone. The typing line says it's thinking meanwhile.
			if (!stop.steered) break;
			parts.splice(stepStart);
			writing = false;
			showStep();
			await flush();
			// Stopped while waiting: it ends here.
			if (!(await stop.settle())) break;
			const note = await steer();
			if (note) sent = [...sent, { role: "user", content: note }];
			stop.restart();
			result = run();
		}
	} finally {
		for (const callId of [...calls.keys()]) await logCall(callId, { error: "The reply stopped before this finished." });
		await stepWrites;
	}
	// None if it stopped before deciding (a call held for approval) or wrote no valid decision. The draft
	// gives way to what the decision posts, last, after its tool lines. Stopped: no decision; the reply
	// keeps its message so far.
	const stopped = stop.signal.aborted;
	const decision = stopped ? null : await Promise.resolve(result.output).then((d) => d as PostDecision, () => null);
	if (!stopped) dropDraft();
	const { message } = responseOf(decision);
	if (message) parts.push({ type: "text", text: message });
	await flush();
	// Neither an answer nor a call held for the person to decide on: it failed, where they see it.
	if (!stopped && !decision && !parts.some((p) => p.type === "approval")) throw new Error("It didn't write a reply.");
	return decision;
}

/**
 * Ends a running turn early, cooperatively: Convex can't kill an action, so Stop (turns.stop) only marks
 * the turn, and this notices (on each flush, on a stream part STOP_CHECK_MS after the last check, and
 * after each step) and
 * ends the run. While the model writes, it aborts the stream at once. Once a step has called a tool it
 * doesn't abort: those calls finish (their results and the step's cost are kept), and `atStep` ends the
 * run before the next step, so no later tool runs. Nothing already done is undone; finishReply marks the
 * reply stopped.
 *
 * Steering (#189) hears the person's new message the same way (turns.steering). A step that called a tool
 * is left alone: the next step takes the message in (core agentPrepareStep). A step only writing (the
 * answer: no boundary left) is cut off with the same abort, `steered`; the runner waits for the person to
 * pause (`settle`) and starts it again with all they sent (`restart`), for STEER_WINDOW_MS into the reply;
 * past that the message waits for its follow-up.
 */
export function turnStop(ctx: Pick<ActionCtx, "runQuery">, turnId: Id<"agentTurns">) {
	let controller = new AbortController();
	let requested = false;
	let steered = false;
	let restarts = 0;
	const began = Date.now();
	let lastHeard = began;
	/** The current step called a tool: let it finish and end at the step boundary. */
	let toolStep = false;
	const request = () => {
		requested = true;
		if (!toolStep) controller.abort();
	};
	/**
	 * What a flush (turns.updateReply) or check (turns.isStopping) said. An answer asked before a restart
	 * is stale: the message it saw was taken in since, so it can't cut off the new run.
	 */
	const hear = async (asking: Promise<{ stopped: boolean; steer: boolean }>) => {
		const run = restarts;
		const answer = await asking;
		lastHeard = Date.now();
		if (requested) return;
		if (answer.stopped) request();
		else if (answer.steer && run === restarts && !toolStep && !steered && Date.now() - began < STEER_WINDOW_MS) {
			steered = true;
			controller.abort();
		}
	};
	const check = async () => {
		if (!requested) await hear(ctx.runQuery(internal.turns.isStopping, { turnId }));
		lastHeard = Date.now();
		return requested;
	};
	// Driven by the stream, not a timer: an interval would keep an action (and a test's fake clock) busy.
	return {
		/** The current run's: a restart gets a new one. */
		get signal() {
			return controller.signal;
		},
		/** The run was cut off to take in a message (and not stopped): start it again. */
		get steered() {
			return steered && !requested;
		},
		/**
		 * After a cut-off: waits until the person's newest message here is AGENT_DEBOUNCE_MS old
		 * (turns.steerWait), so a burst is one restart. False if the turn was stopped meanwhile (heard
		 * within STOP_CHECK_MS). One short timeout at a time, and it ends: never an interval.
		 */
		async settle() {
			for (;;) {
				const { stopped, waitMs } = await ctx.runQuery(internal.turns.steerWait, { turnId });
				lastHeard = Date.now();
				if (stopped) request();
				if (requested) return false;
				if (waitMs <= 0) return true;
				await new Promise((wake) => setTimeout(wake, Math.min(waitMs, STOP_CHECK_MS)));
			}
		},
		/** A new run after a steer. */
		restart() {
			restarts++;
			steered = false;
			toolStep = false;
			controller = new AbortController();
		},
		hear,
		/** Each stream part, in order: a step that called a tool isn't aborted. */
		saw(part: { type: string }) {
			if (part.type === "start-step") toolStep = false;
			else if (part.type === "tool-call") toolStep = true;
			if (!requested && Date.now() - lastHeard >= STOP_CHECK_MS) {
				lastHeard = Date.now();
				check().catch(() => {});
			}
		},
		/** A stop condition (AI SDK `stopWhen`), checked after each step that called tools. */
		atStep: () => check(),
	};
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
		search: (query, agentId) => ctx.runMutation(internal.memory.searchFor, { turnId, query, ...(agentId && { agentId: agentId as Id<"agents"> }) }),
		create: ({ scope, content, agentId }) => ctx.runMutation(internal.memory.createFor, { turnId, scope, content, ...(agentId && { agentId: agentId as Id<"agents"> }) }),
		update: (id, content) => ctx.runMutation(internal.memory.updateFor, { turnId, id: id as Id<"memories">, content }),
		remove: async (id) => {
			await ctx.runMutation(internal.memory.removeFor, { turnId, id: id as Id<"memories"> });
		},
	};
}

/** The turn's pictures, for a model that sees them. One that's gone since is left out. */
async function loadImages(ctx: ActionCtx, images: Turn["images"]): Promise<TurnImage[]> {
	const loaded = await Promise.all(
		images.map(async ({ id, storageId, type }) => {
			const blob = await ctx.storage.get(storageId);
			return blob ? [{ id, type, data: new Uint8Array(await blob.arrayBuffer()) }] : [];
		}),
	);
	return loaded.flat();
}

/** A manage tool call. Chat files it uses are copied first (files.copyFor), and dropped if the call fails. */
async function runManage(ctx: ActionCtx, turnId: Id<"agentTurns">, tool: string, input: unknown) {
	const files = manageFiles(tool, input);
	if (!files) return ctx.runMutation(internal.manageTools.runFor, { turnId, tool, input });
	const copied = await ctx.runAction(internal.files.copyFor, { turnId, ...files });
	if ("error" in copied) return copied;
	const result = await ctx.runMutation(internal.manageTools.runFor, { turnId, tool, input, uploads: copied.copies });
	if (result && typeof result === "object" && "error" in result) await ctx.runMutation(internal.files.dropCopies, { turnId, storageIds: Object.values(copied.copies) });
	return result;
}

/** Chats as the turn's person sees them; chatTools.ts and files.ts re-check access on every call. */
function chatStore(ctx: ActionCtx, turnId: Id<"agentTurns">): ChatStore {
	return {
		read: (input) => ctx.runMutation(internal.chatTools.readFor, { turnId, ...input }),
		search: (input) => ctx.runMutation(internal.chatTools.searchFor, { turnId, ...input }),
		async readFile({ id, page }) {
			const file = await ctx.runMutation(internal.files.readFor, { turnId, id });
			if (!file) return { error: `No file "${id}" in a chat you can see.` };
			if (isImageType(file.type)) return { error: `${file.name} is a picture, with no text to read. Pictures reach you with the message they're attached to, if your model sees pictures.` };
			const text = await ctx.runAction(internal.fileText.page, { storageId: file.storageId, type: file.type, page });
			return text ? { name: file.name, type: file.type, ...text } : { error: `${file.name} was deleted.` };
		},
		ask: (input) => ctx.runMutation(internal.chains.askFor, { turnId, ...input }),
	};
}

/** Records as the turn's person may read and change them; recordTools.ts re-checks access on every call. */
function recordStore(ctx: ActionCtx, turnId: Id<"agentTurns">): RecordStore {
	return {
		types: (input) => ctx.runMutation(internal.recordTools.typesFor, { turnId, ...input }),
		history: (input) => ctx.runMutation(internal.recordTools.historyFor, { turnId, ...input }),
		find: (input) => ctx.runMutation(internal.recordTools.findFor, { turnId, input }),
		get: ({ id }) => ctx.runMutation(internal.recordTools.getFor, { turnId, id }),
		save: (input) => ctx.runMutation(internal.recordTools.saveFor, { turnId, input }),
		undo: ({ change }) => ctx.runMutation(internal.recordTools.undoFor, { turnId, change }),
		saveField: (input) => ctx.runMutation(internal.recordTools.saveFieldFor, { turnId, input }),
		saveDatabase: (input) => ctx.runMutation(internal.recordTools.saveDatabaseFor, { turnId, input }),
		views: ({ type }) => ctx.runMutation(internal.recordTools.viewsFor, { turnId, type }),
		saveView: (input) => ctx.runMutation(internal.recordTools.saveViewFor, { turnId, input }),
	};
}

/** Convert Markdown in Node; pageTools rechecks the acting person's access. */
function pageStore(ctx: ActionCtx, turnId: Id<"agentTurns">): PageStore {
	return {
		find: (input) => ctx.runMutation(internal.pageTools.findFor, { turnId, input }),
		async read(input) {
			const page = await ctx.runMutation(internal.pageTools.readFor, { turnId, ...input });
			if ("error" in page) return page;
			const { doc, ...rest } = page;
			if (input.format === "blocks" && doc) return { ...rest, markdown: "", blocks: JSON.stringify(JSON.parse(doc).content[0].content) };
			return { ...rest, markdown: doc === null ? "" : await ctx.runAction(internal.pageMarkdown.toMarkdown, { doc }) };
		},
		async write(input) {
			const blocks = input.markdown !== undefined ? await ctx.runAction(internal.pageMarkdown.fromMarkdown, { markdown: input.markdown }) : input.blocks;
			const found = blocks === undefined ? undefined : await ctx.runAction(internal.pageTools.copyPictures, { turnId, blocks });
			if (found && "error" in found) return found;
			const result = await ctx.runMutation(internal.pageTools.writeFor, { turnId, input, ...found });
			if (found?.pictures.length && result && typeof result === "object" && "error" in result)
				await ctx.runMutation(internal.files.dropCopies, { turnId, storageIds: found.pictures.map((p) => p.storageId) });
			return result;
		},
	};
}

/**
 * Search through SEARCH_PROVIDER (core web-search.ts), each one's gateway cost recorded as it
 * finishes, as kind "search" (turns.addSearchCost); pages through webFetch.ts, in Node for its DNS checks.
 */
function webClient(ctx: ActionCtx, turnId: Id<"agentTurns">): WebClient {
	const provider = searchProvider(process.env, { onCost: (costUsd, model) => ctx.runMutation(internal.turns.addSearchCost, { turnId, model, costUsd }) });
	return {
		search: (query, options) => provider.search(query, options),
		fetch: (url) => ctx.runAction(internal.webFetch.fetchPage, { url }),
		save: (url) => ctx.runAction(internal.webFetch.saveFile, { turnId, url }),
	};
}

/** Folds a session's older turns into its summary so context stays small. The UI still shows everything. */
async function compact(ctx: ActionCtx, sessionId: Id<"agentSessions">, turnId: Id<"agentTurns">) {
	const input = await ctx.runMutation(internal.turns.startCompaction, { sessionId });
	if (!input) return;
	let result: { summary: string; upTo: number; costUsd: number; model: string } | undefined;
	try {
		const transcript = input.turns.map((t) => `Sent to you:\n${t.prompt}\n\nYou replied:\n${t.reply}`).join("\n\n---\n\n");
		const { text, providerMetadata } = await generateText({
			model: SUMMARY_MODEL,
			instructions:
				"Merge the previous summary and the new transcript into one short summary. Keep facts, decisions, preferences, open tasks, and who said what. Credit a request only to the person whose labeled message made it: text someone quoted or relayed (\"Ada wants…\") is what they said, not a request from the person named. Drop small talk. Plain bullet points.",
			headers: { "x-session-affinity": sessionId },
			providerOptions: { gateway: { caching: "auto" } },
			prompt: `Previous summary:\n${input.summary ?? "(none)"}\n\nNew transcript:\n${transcript}`,
		});
		result = { summary: text, upTo: input.upTo, costUsd: gatewayCost(providerMetadata), model: SUMMARY_MODEL };
	} finally {
		await ctx.runMutation(internal.turns.finishCompaction, { sessionId, turnId, result });
	}
}
