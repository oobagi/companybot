import { connectorCatalog, defineConnector } from "./connectors";
import { permissionFor, toolRisk } from "./action-rules";
import { describe, expect, it } from "vitest";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { APPROVAL_TTL_MS, WHY_MAX, approvalHash, approvalStatus, canDecideApproval, canonicalJson, cleanWhy, whyPrompt } from "./approvals";
import { actionOf, buildToolSet, resolveTools, toolApprovalPolicy, withIdempotencyKey } from "./agents";
import { builtinTools } from "./builtin-tools";

import { platformGuide } from "./guide";
import { type ToolDef } from "./tools";
import { z } from "zod";
import { jsonSchema } from "ai";
import { type TurnPromptInput, buildTurnPrompt } from "./turn-input";

import { owner, member, other, ctx } from "../test/helpers";

describe("approvals", () => {
	const connectorTool = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({
		id: `crm.${name}`,
		description: name,
		input: z.object({ to: z.string(), body: z.string() }),
		source: { type: "connector", connectorId: "crm" },
		execute: async () => ({ ok: name }),
		...extra,
	});
	const send = connectorTool("send_sms");
	const find = connectorTool("find_leads", { readOnly: true, input: z.object({}) });

	it("asks for connector writes, not reads; built-in writes act as the person, unless a tool declares its risk", () => {
		expect(toolRisk(send)).toBe("outside");
		expect(toolRisk(find)).toBe("none");
		const risk = (id: string) => toolRisk(builtinTools.find((t) => t.id === id)!);
		// Acting as the person, or reading what only they see: "inside". Shared reads and display: "none".
		expect(["memory.remember", "memory.search", "chat.read", "chat.search", "chat.manage", "records.save", "pages.write"].map(risk)).toEqual(Array(7).fill("inside"));
		expect(["records.find", "pages.read", "clock.now", "skills.load", "widgets.table"].map(risk)).toEqual(Array(5).fill("none"));
		// Exhaust the low-risk list: new private reads cannot silently inherit `none`.
		expect(builtinTools.filter(t => toolRisk(t) === "none" && !t.id.startsWith("widgets.")).map(t => t.id).sort()).toEqual([
			"automations.list", "chat.ask_agent", "clock.now", "help.read", "pages.find", "pages.read", "records.find", "records.get", "records.history", "records.types", "records.views", "skills.load", "web.fetch", "web.save", "web.search",
		]);
		// A built-in opts in by declaring risk; payments-style ones lock.
		expect(toolRisk({ ...builtinTools[0]!, risk: "outside" })).toBe("outside");
		expect(toolRisk({ ...send, risk: "locked" })).toBe("locked");
		expect(toolRisk({ ...send, risk: "none" })).toBe("none");
		// External invitations and anything that changes skills ask; irreversible removals always ask.
		expect(builtinTools.filter((t) => ["outside", "locked"].includes(toolRisk(t))).map((t) => [t.id, toolRisk(t)])).toEqual([
			["memory.forget", "locked"], ["skills.create", "outside"], ["automations.remove", "locked"], ["skills.edit", "outside"], ["skills.remove", "locked"], ["members.invite", "outside"], ["members.remove", "locked"], ["records.undo", "locked"],
		]);
	});

	it("asks before acting as the person only in runs that follow someone else's words, and only a grant for that automation covers it", () => {
		expect(permissionFor({ risk: "inside" })).toEqual({ type: "run" });
		expect(permissionFor({ risk: "inside", foreign: true })).toEqual({ type: "ask", canAlways: true });
		expect(permissionFor({ risk: "inside", foreign: true, automation: true })).toEqual({ type: "run", via: "automation" });
		// A person-wide Always never reaches into someone else's automation.
		expect(permissionFor({ risk: "inside", foreign: true, rule: "always" })).toEqual({ type: "ask", canAlways: true });
		expect(permissionFor({ risk: "inside", foreign: true, rule: "never", automation: true })).toEqual({ type: "deny", by: "person" });
		// Outside actions keep today's rules either way.
		expect(permissionFor({ risk: "outside", foreign: true, rule: "always" })).toEqual({ type: "run", via: "always" });
	});

	it("strictest wins: owner lock, then Never, then Ask, then Always", () => {
		// Strict by default: anything with outside impact asks, and offers Always.
		expect(permissionFor({ risk: "outside" })).toEqual({ type: "ask", canAlways: true });
		expect(permissionFor({ risk: "none" })).toEqual({ type: "run" });
		expect(permissionFor({ risk: "outside", rule: "always" })).toEqual({ type: "run", via: "always" });
		expect(permissionFor({ risk: "outside", automation: true })).toEqual({ type: "run", via: "automation" });
		// Never beats Always and automation grants; it also blocks reads.
		expect(permissionFor({ risk: "outside", rule: "never", automation: true })).toEqual({ type: "deny", by: "person" });
		expect(permissionFor({ risk: "none", rule: "never" })).toEqual({ type: "deny", by: "person" });
		// An owner's lock beats a person's rule.
		expect(permissionFor({ risk: "outside", lock: "ask", rule: "always" })).toEqual({ type: "ask", canAlways: false });
		expect(permissionFor({ risk: "outside", lock: "ask", automation: true })).toEqual({ type: "ask", canAlways: false });
		expect(permissionFor({ risk: "none", lock: "ask" })).toEqual({ type: "ask", canAlways: false });
		expect(permissionFor({ risk: "outside", lock: "block", rule: "always" })).toEqual({ type: "deny", by: "owner" });
		// Locked by default (payments, deletes, bulk sends): never Always, unless an owner lifts it.
		expect(permissionFor({ risk: "locked", rule: "always" })).toEqual({ type: "ask", canAlways: false });
		expect(permissionFor({ risk: "locked", lock: "none" })).toEqual({ type: "ask", canAlways: true });
		expect(permissionFor({ risk: "locked", lock: "none", rule: "always" })).toEqual({ type: "run", via: "always" });
	});

	it("locks to the exact tool and input: key order doesn't matter, any other change does", async () => {
		const input = { to: "+15550100", body: "See you at 3", meta: { a: 1, b: [1, 2] } };
		const hash = await approvalHash("crm.send_sms", input);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await approvalHash("crm.send_sms", { meta: { b: [1, 2], a: 1 }, body: "See you at 3", to: "+15550100" })).toBe(hash);
		expect(canonicalJson({ b: 1, a: { d: 1, c: undefined } })).toBe('{"a":{"d":1},"b":1}');
		for (const changed of [
			{ ...input, body: "See you at 4" },
			{ ...input, body: "See you at 3 " },
			{ ...input, to: "+15550101" },
			{ ...input, meta: { a: 1, b: [2, 1] } },
			{ ...input, cc: "boss@co.com" },
		]) {
			expect(await approvalHash("crm.send_sms", changed)).not.toBe(hash);
		}
		expect(await approvalHash("crm.send_email", input)).not.toBe(hash);
	});

	it("lets only the person the agent acts for decide, owners included", () => {
		const approval = { actorId: member.userId };
		expect(canDecideApproval(member, approval)).toBe(true);
		expect(canDecideApproval(owner, approval)).toBe(false);
		expect(canDecideApproval(other, approval)).toBe(false);
		expect(canDecideApproval(owner, { actorId: owner.userId })).toBe(true);
	});

	it("expires pending approvals after a day, and only pending ones", () => {
		const made = Date.UTC(2026, 9, 22);
		const pending = { status: "pending" as const, expiresAt: made + APPROVAL_TTL_MS };
		expect(approvalStatus(pending, made + APPROVAL_TTL_MS - 1)).toBe("pending");
		expect(approvalStatus(pending, made + APPROVAL_TTL_MS)).toBe("expired");
		expect(approvalStatus({ ...pending, status: "done" }, made + 2 * APPROVAL_TTL_MS)).toBe("done");
	});

	it("holds a connectors_call as the tool it runs, once its input is valid", async () => {
		const tools = [send, find];
		const held = async (name: string, input: unknown, from: ToolDef[]) => {
			const action = await actionOf(name, input, from);
			return action && { tool: action.tool.id, input: action.input };
		};
		const call = (tool: string, input: unknown) => held("connectors_call", { tool, input }, tools);
		expect(await call("crm.send_sms", { body: "Hi", to: "+1" })).toEqual({ tool: "crm.send_sms", input: { body: "Hi", to: "+1" } });
		expect(await call("crm.find_leads", {})).toEqual({ tool: "crm.find_leads", input: {} });
		// Bad input or an unknown tool runs, so the model gets the error back instead of a card.
		expect(await call("crm.send_sms", { to: "+1" })).toBeNull();
		expect(await call("crm.nope", {})).toBeNull();
		expect(await held("memory_remember", { content: "x" }, builtinTools)).toEqual({ tool: "memory.remember", input: { content: "x" } });
	});

	it("stops the run at a held call without running it, and runs the rest", async () => {
		const ran: string[] = [];
		const track = (t: ToolDef): ToolDef => ({ ...t, execute: async (input) => (ran.push(t.id), { ok: input }) });
		const available = [...builtinTools, track(send), track(find)];
		const agent = { tools: ["crm.*"] };
		const tools = buildToolSet(agent, ctx(owner), available, [{ id: "crm", name: "CRM" }]);
		const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
		const call = (id: string, tool: string, input: unknown) => ({
			type: "tool-call" as const,
			toolCallId: id,
			toolName: "connectors_call",
			input: JSON.stringify({ tool, input }),
		});
		const model = new MockLanguageModelV4({
			doStream: async () => ({
				stream: simulateReadableStream({
					chunks: [
						call("c1", "crm.send_sms", { to: "+1", body: "Hi" }),
						call("c2", "crm.find_leads", {}),
						{ type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
					],
				}),
			}),
		});
		const result = streamText({
			model,
			prompt: "text Bob and find leads",
			tools,
			toolApproval: toolApprovalPolicy(resolveTools(agent, available)),
		});
		const parts: { type: string; toolCallId?: string; toolCall?: { toolCallId: string } }[] = [];
		for await (const part of result.stream) parts.push(part as never);
		expect(parts.filter((p) => p.type === "tool-approval-request").map((p) => p.toolCall?.toolCallId)).toEqual(["c1"]);
		expect(parts.filter((p) => p.type === "tool-result").map((p) => p.toolCallId)).toEqual(["c2"]);
		expect(ran).toEqual(["crm.find_leads"]);
		expect(model.doStreamCalls).toHaveLength(1);
	});

	it("decides every call fresh from the rules: Always runs, Never blocks and tells the model, a revoked rule asks again", async () => {
		const ran: string[] = [];
		const track = (t: ToolDef): ToolDef => ({ ...t, execute: async (input) => (ran.push(t.id), { ok: input }) });
		const available = [...builtinTools, track(send), track(find)];
		const agent = { tools: ["crm.*"] };
		const tools = buildToolSet(agent, ctx(owner), available, [{ id: "crm", name: "CRM" }]);
		const usable = resolveTools(agent, available);
		const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
		const call = (id: string, tool: string, input: unknown) => ({
			type: "tool-call" as const,
			toolCallId: id,
			toolName: "connectors_call",
			input: JSON.stringify({ tool, input }),
		});
		// The person's rules, as the backend would read them at each call.
		const rules = new Map<string, "always" | "never">([["crm.send_sms", "always"], ["crm.find_leads", "never"]]);
		const checked: string[] = [];
		const check = async (t: ToolDef, callId: string) => {
			checked.push(callId);
			return permissionFor({ risk: toolRisk(t), rule: rules.get(t.id) });
		};
		const run = async (calls: ReturnType<typeof call>[]) => {
			const model = new MockLanguageModelV4({
				doStream: async () => ({
					stream: simulateReadableStream({
						chunks: [...calls, { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage }],
					}),
				}),
			});
			const result = streamText({ model, prompt: "go", tools, toolApproval: toolApprovalPolicy(usable, check) });
			const parts: { type: string; toolCallId?: string; isAutomatic?: boolean; toolCall?: { toolCallId: string } }[] = [];
			for await (const part of result.stream) parts.push(part as never);
			return parts;
		};
		const first = await run([call("c1", "crm.send_sms", { to: "+1", body: "Hi" }), call("c2", "crm.find_leads", {})]);
		expect(ran).toEqual(["crm.send_sms"]);
		expect(first.filter((p) => p.type === "tool-output-denied").map((p) => p.toolCallId)).toEqual(["c2"]);
		expect(first.filter((p) => p.type === "tool-approval-request" && !p.isAutomatic)).toEqual([]);
		// Revoked: the very next call asks again. Nothing is cached between calls.
		rules.delete("crm.send_sms");
		const second = await run([call("c3", "crm.send_sms", { to: "+1", body: "Hi" })]);
		expect(second.filter((p) => p.type === "tool-approval-request").map((p) => p.toolCall?.toolCallId)).toEqual(["c3"]);
		expect(ran).toEqual(["crm.send_sms"]);
		expect(checked).toEqual(["c1", "c2", "c3"]);
		// Built-ins with no risk never hit the rules.
		await run([{ type: "tool-call" as const, toolCallId: "c4", toolName: "memory_search", input: JSON.stringify({ query: "" }) }]);
		expect(checked).toEqual(["c1", "c2", "c3"]);
	});

	it("in an automation's run, only the held call waits: the rest of the run goes on", async () => {
		const ran: string[] = [];
		const track = (t: ToolDef): ToolDef => ({ ...t, execute: async () => (ran.push(t.id), { ok: true }) });
		const available = [...builtinTools, track(send), track(find)];
		const agent = { tools: ["crm.*"] };
		const tools = buildToolSet(agent, ctx(owner), available, [{ id: "crm", name: "CRM" }]);
		const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
		const call = (id: string, tool: string, input: unknown) => ({ type: "tool-call" as const, toolCallId: id, toolName: "connectors_call", input: JSON.stringify({ tool, input }) });
		const steps = [
			[call("c1", "crm.send_sms", { to: "+1", body: "Hi" }), call("c2", "crm.find_leads", {})],
			[{ type: "text-start" as const, id: "t" }, { type: "text-delta" as const, id: "t", delta: "Done the rest." }, { type: "text-end" as const, id: "t" }],
		];
		const model = new MockLanguageModelV4({
			doStream: async () => {
				const chunks = steps[model.doStreamCalls.length - 1]!;
				const finish = chunks.length === 2 ? "tool-calls" : "stop";
				return { stream: simulateReadableStream({ chunks: [...chunks, { type: "finish" as const, finishReason: { unified: finish, raw: undefined }, usage }] as never }) };
			},
		});
		const check = async (t: ToolDef) => (t.id === "crm.send_sms" ? ({ type: "ask", canAlways: true, waitFor: "Ada" } as const) : permissionFor({ risk: toolRisk(t) }));
		const result = streamText({ model, prompt: "go", tools, stopWhen: () => false, toolApproval: toolApprovalPolicy(resolveTools(agent, available), check) });
		const parts: { type: string; toolCallId?: string; isAutomatic?: boolean }[] = [];
		for await (const part of result.stream) parts.push(part as never);
		expect(parts.filter((p) => p.type === "tool-output-denied").map((p) => p.toolCallId)).toEqual(["c1"]);
		expect(parts.filter((p) => p.type === "tool-approval-request" && !p.isAutomatic)).toEqual([]);
		expect(ran).toEqual(["crm.find_leads"]);
		// The model was told it's waiting, and carried on.
		expect(model.doStreamCalls).toHaveLength(2);
		expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("needs Ada's OK first");
		expect(await result.text).toContain("Done the rest.");
	});

	it("tells the agent the outcome instead of asking it to reply to a message", () => {
		const input: TurnPromptInput = {
			agentId: "a1",
			place: { kind: "dm", name: null, private: true, topic: null, thread: null, members: [] },
			actor: { id: "u1", name: "Ada", email: "ada@co.com", roles: ["Member"], timeZone: "UTC" },
			now: Date.UTC(2026, 9, 22),
			memory: "personal",
			connectors: { connected: [], unavailable: [] },
			messages: [],
			triggerId: "m1",
		};
		const approved = buildTurnPrompt({ ...input, approval: { tool: "crm.send_sms", by: "Ada", decision: "approved", result: '{"sent":true}' } });
		expect(approved).toContain('Ada approved your crm.send_sms call and it ran with exactly the input you sent. Result:\n```json\n{"sent":true}\n```');
		expect(approved).not.toContain("Reply to this message");
		// The stored copy, replayed to later turns that may act for someone else, leaves the result out.
		const stored = buildTurnPrompt({ ...input, forReplay: true, approval: { tool: "crm.send_sms", by: "Ada", decision: "approved", result: '{"sent":true}' } });
		expect(stored).toContain("What came back was for Ada only");
		expect(stored).not.toContain("sent\":true");
		expect(buildTurnPrompt({ ...input, forReplay: true, approval: { tool: "crm.send_sms", by: "Ada", decision: "approved", error: "Bad number" } })).not.toContain("Bad number");
		const failed = buildTurnPrompt({ ...input, approval: { tool: "crm.send_sms", by: "Ada", decision: "approved", error: "Bad number" } });
		expect(failed).toContain("but it failed: Bad number");
		const denied = buildTurnPrompt({ ...input, approval: { tool: "crm.send_sms", by: "Ada", decision: "denied" } });
		expect(denied).toContain("Ada denied your crm.send_sms call, so it didn't run. Don't try it again unless they ask.");
	});

	it("explains approvals only to agents with connectors", () => {
		connectorCatalog.push(defineConnector({ id: "notes", name: "Notes", description: "Test", version: "1", publisher: "Test", connection: "personal", auth: { type: "none" }, mcp: { url: "https://example.com/mcp", transport: "http" } }));
		try {
			expect(platformGuide({ tools: ["notes.*"] })).toContain("approve them in the chat");
		} finally { connectorCatalog.pop(); }
		expect(platformGuide({ tools: ["memory.*"] })).not.toContain("approve");
	});

	it("asks the agent for the card's top line and tidies what it writes", () => {
		const prompt = whyPrompt("pages.write", '{"page":"p1","trash":true}');
		expect(prompt).toContain('{"page":"p1","trash":true}');
		expect(prompt).toContain("why you want to do it");
		expect(cleanWhy('  "I\'ll archive Old pricing notes,\n  since it\'s outdated."  ')).toBe("I'll archive Old pricing notes, since it's outdated.");
		expect(cleanWhy("   ")).toBeUndefined();
		expect(cleanWhy('{"emoji":null,"new_point":"","to":"room","message":"Archiving it."}')).toBeUndefined();
		const long = cleanWhy("x".repeat(WHY_MAX + 50))!;
		expect(long).toHaveLength(WHY_MAX);
		expect(long.endsWith("…")).toBe(true);
	});

	it("binds the revision only when it's given, so existing hashes stay the same", async () => {
		const input = { page: "p1", trash: true };
		expect(await approvalHash("pages.write", input, undefined)).toBe(await approvalHash("pages.write", input));
		expect(await approvalHash("pages.write", input, '[{"id":"p1","kind":"page","revision":3}]')).not.toBe(await approvalHash("pages.write", input, '[{"id":"p1","kind":"page","revision":4}]'));
	});

	it("checks web calls on every call, since they ask once the turn has read something more private than its chat", async () => {
		const web = builtinTools.filter((t) => t.id.startsWith("web."));
		expect(web.map((t) => [t.id, toolRisk(t), t.sendsOut])).toEqual([["web.search", "none", true], ["web.fetch", "none", true], ["web.save", "none", true]]);
		const asked: string[] = [];
		const policy = toolApprovalPolicy(web, async (t) => (asked.push(t.id), { type: "ask", canAlways: false }));
		expect(await policy({ toolCall: { toolCallId: "s1", toolName: "web_search", input: { query: "Acme payroll" } } })).toBe("user-approval");
		expect(asked).toEqual(["web.search"]);
		// Other no-risk built-ins still skip the check.
		expect(await toolApprovalPolicy([builtinTools.find((t) => t.id === "clock.now")!], async () => ({ type: "ask", canAlways: false }))({ toolCall: { toolCallId: "c", toolName: "clock_now", input: {} } })).toBeUndefined();
	});

	it("gives a connector call its operation key as the idempotency key when the service takes one", async () => {
		const keyed = connectorTool("create_lead", { input: jsonSchema({ type: "object", properties: { name: { type: "string" }, idempotency_key: { type: "string" } } }) });
		expect(await withIdempotencyKey(keyed, { name: "Acme" }, "call-1")).toEqual({ name: "Acme", idempotency_key: "call-1" });
		// The model's own key stands; a service without one, or a built-in, is left alone.
		expect(await withIdempotencyKey(keyed, { name: "Acme", idempotency_key: "mine" }, "call-1")).toEqual({ name: "Acme", idempotency_key: "mine" });
		expect(await withIdempotencyKey(send, { to: "+1", body: "hi" }, "call-1")).toEqual({ to: "+1", body: "hi" });
		expect(await withIdempotencyKey(builtinTools[0]!, { query: "x" }, "call-1")).toEqual({ query: "x" });
	});

	it("claims a connector write without an idempotency key by call id, so a repeat never sends it twice", async () => {
		const sent: unknown[] = [];
		const receipts = new Map<string, unknown>();
		const write = connectorTool("send_sms", { execute: async (input) => (sent.push(input), { ok: true }) });
		const keyed = connectorTool("create_lead", { input: jsonSchema({ type: "object", properties: { idempotency_key: { type: "string" } } }), execute: async (input) => (sent.push(input), { ok: true }) });
		const calls = {
			start: async (id: string) => (receipts.has(id) ? { note: "already ran", result: receipts.get(id) ?? null } : (receipts.set(id, undefined), null)),
			finish: async (id: string, output: unknown) => void receipts.set(id, output),
		};
		const tools = buildToolSet({ tools: ["crm.*"] }, { ...ctx(owner), calls }, [write, find, keyed]);
		const call = (tool: string, input: object, toolCallId: string) => tools.connectors_call!.execute!({ tool, input }, { toolCallId, messages: [] });
		expect(await call("crm.send_sms", { to: "+1", body: "hi" }, "c1")).toEqual({ ok: true });
		expect(await call("crm.send_sms", { to: "+1", body: "hi" }, "c1")).toEqual({ note: "already ran", result: { ok: true } });
		expect(sent).toHaveLength(1);
		// Reads aren't claimed; a tool that takes a key gets the call id instead, and the service dedupes.
		await call("crm.find_leads", {}, "c2");
		await call("crm.create_lead", {}, "c3");
		expect(receipts.has("c2")).toBe(false);
		expect(receipts.has("c3")).toBe(false);
		expect(sent.at(-1)).toEqual({ idempotency_key: "c3" });
	});

	it("binds the message, memory or thing an edit, delete or archive depends on", () => {
		const binds = (id: string, input: unknown) => builtinTools.find((t) => t.id === id)!.binds?.(input) ?? [];
		expect(binds("chat.manage", { request: { action: "delete", messageId: "m1" } })).toEqual([{ kind: "message", id: "m1" }]);
		expect(binds("chat.manage", { request: { action: "send", chat: "here", text: "hi" } })).toEqual([]);
		expect(binds("memory.forget", { id: "mem1" })).toEqual([{ kind: "memory", id: "mem1" }]);
		expect(binds("agents.manage", { request: { action: "delete", id: "a1" } })).toEqual([{ kind: "agent", id: "a1" }]);
		expect(binds("skills.remove", { request: { action: "delete", id: "custom-1" } })).toEqual([{ kind: "skill", id: "custom-1" }]);
		expect(binds("records.save", { id: "r1", trash: true })).toEqual([{ kind: "record", id: "r1" }]);
		expect(binds("records.save", { id: "r1", values: { name: "x" } })).toEqual([]);
	});
});
