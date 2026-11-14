import { approvalHash, canonicalJson } from "@companybot/core";
import { Transform } from "@tiptap/pm/transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { pageSchema, readDoc, sync } from "../convex/pageOps";
import { type As, agentTurn, agentsOf, generalOf, identityOf, ownerAndMember, settle, signIn, turnsOf } from "./helpers";
import "./connectorFixtures";

// Agent safety (#215): approvals name what they change by id and bind the revision they were shown, an
// approved call commits its effect with its receipt once, and nothing leaves the workspace unseen after a
// reply read something its chat can't all see. No network: the runner's model call is a scripted stream.
const streamText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), streamText }));
// web.save downloads through safeFetch: a 1×1 PNG, no network.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const safeFetch = vi.hoisted(() => vi.fn());
vi.mock("@companybot/core/safe-fetch", async (original) => ({ ...(await original<typeof import("@companybot/core/safe-fetch")>()), safeFetch }));
beforeEach(() => void safeFetch.mockImplementation(async (url: string) => ({ url, status: 200, contentType: "image/png", bytes: PNG, cut: false })));

/** A run that just answers, as the model streams it. */
function answers(message: string) {
	const text = JSON.stringify({ emoji: null, new_point: "", to: "room", message });
	streamText.mockImplementationOnce(() => ({
		output: Promise.resolve(JSON.parse(text)),
		stream: (async function* () {
			yield { type: "start-step" };
			yield { type: "text-delta", text };
			yield { type: "finish-step", usage: { inputTokens: 10, outputTokens: 5 }, providerMetadata: { gateway: { cost: "0" } } };
		})(),
	}));
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	streamText.mockReset();
	safeFetch.mockReset();
});

type T = Awaited<ReturnType<typeof ownerAndMember>>["t"];
type Person = Awaited<ReturnType<typeof signIn>>;

/** `as` asks Companybot in #general and its reply holds `input` for `tool`. Returns the card. */
async function holdCall(t: T, as: As, tool: string, input: object, risk: "inside" | "locked") {
	const { companybot } = await agentsOf(as);
	const turnId = await agentTurn(t, as, (await generalOf(as))._id, companybot._id);
	await t.mutation(internal.turns.savePrompt, { turnId, prompt: "Reply to this message" });
	const { approvalId } = await t.mutation(internal.approvals.request, { turnId, callId: "c1", tool, input: canonicalJson(input), risk });
	await t.mutation(internal.turns.updateReply, { turnId, text: "", parts: [{ type: "approval", id: "c1", approvalId, tool }] });
	await t.mutation(internal.turns.finishReply, { turnId });
	const replyId = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
	const [card] = await as.query(api.approvals.forReply, { replyId });
	return { turnId, approvalId, card: card! };
}
const holdPageWrite = (t: T, as: As, input: object, risk: "inside" | "locked") => holdCall(t, as, "pages.write", input, risk);
/** Approves the card, then claims it for the turn that runs it, as the runner does. */
async function approveAndClaim(t: T, as: As, held: Awaited<ReturnType<typeof holdCall>>) {
	await approve(as, held.approvalId, held.card.hash);
	const resume = (await turnsOf(t)).at(-1)!._id;
	return { resume, claimed: await t.mutation(internal.approvals.claim, { approvalId: held.approvalId, turnId: resume }) };
}
const paragraph = (text: string) => ({ type: "blockContainer", attrs: { id: crypto.randomUUID() }, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const approve = (as: As, approvalId: Id<"approvals">, hash: string) => as.mutation(api.approvals.decide, { approvalId, hash, approve: true, always: false });
const approvalOf = (t: T, id: Id<"approvals">) => t.run((ctx) => ctx.db.get(id));
const pageOf = (t: T, id: Id<"pages">) => t.run((ctx) => ctx.db.get(id));

/** Types `text` into the page as `as`'s editor does. */
async function type(t: T, as: Person, pageId: Id<"pages">, text: string) {
	const editor = identityOf(t, as.userId);
	const { doc, version } = await t.run(async (ctx) => {
		const latest = await sync.getDoc(ctx, pageId, pageSchema());
		return { doc: latest.doc.toJSON(), version: latest.version };
	});
	const tr = new Transform(pageSchema().nodeFromJSON(doc)).insert(3, pageSchema().text(text));
	const steps = tr.steps.map((s) => JSON.stringify(s.toJSON()));
	await editor.mutation(api.pageSync.submitSteps, { id: pageId, version, clientId: "editor", steps });
	await editor.mutation(api.pageSync.submitSnapshot, { id: pageId, version: version + steps.length, content: JSON.stringify(tr.doc.toJSON()) });
}

describe("approvals bind ids, not names", () => {
	it("archives the approved page even after a rename, never a new page that took its old title", async () => {
		const { t, owner } = await ownerAndMember();
		const audit = await owner.mutation(api.pages.create, { title: "Audit budget" });
		const { approvalId, card } = await holdPageWrite(t, owner, { page: audit, trash: true }, "locked");
		// The card shows the exact page it will archive.
		expect(card.input).toBe(canonicalJson({ page: audit, trash: true }));
		await approve(owner, approvalId, card.hash);
		await owner.mutation(api.pages.rename, { pageId: audit, title: "Audit budget (old)" });
		const impostor = await owner.mutation(api.pages.create, { title: "Audit budget" });

		const resume = (await turnsOf(t)).at(-1)!;
		vi.useRealTimers();
		answers("Archived it.");
		await t.action(internal.agent.respond, { turnId: resume._id });

		expect((await pageOf(t, audit))!.archived).toBe(true);
		expect((await pageOf(t, impostor))!.archived).toBe(false);
		expect(await approvalOf(t, approvalId)).toMatchObject({ status: "done" });
	});

	it("refuses a page named by title in a write", async () => {
		const { t, owner } = await ownerAndMember();
		await owner.mutation(api.pages.create, { title: "Audit budget" });
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
		expect(await t.mutation(internal.pageTools.writeFor, { turnId, input: { page: "Audit budget", trash: true } })).toEqual({ error: expect.stringContaining("Name the page by its id") });
	});

	it("won't overwrite a page that was edited after the overwrite was approved", async () => {
		const { t, owner } = await ownerAndMember();
		const pageId = await owner.mutation(api.pages.create, { title: "Plan" });
		const input = { page: pageId, markdown: "Fresh start", mode: "replace" };
		const { approvalId, card } = await holdPageWrite(t, owner, input, "inside");
		// The hash covers the revision shown, not only the call.
		expect(card.hash).not.toBe(await approvalHash("pages.write", input));
		await approve(owner, approvalId, card.hash);
		await type(t, owner, pageId, "Edited by hand");

		const resume = (await turnsOf(t)).at(-1)!;
		expect(await t.mutation(internal.approvals.claim, { approvalId, turnId: resume._id })).toBeNull();
		expect(await approvalOf(t, approvalId)).toMatchObject({ status: "failed", error: expect.stringContaining("edited after it was approved") });
	});
});

describe("approved calls commit once, with their receipt", () => {
	it("writes the effect, the approval's result and one activity line together; the same approval never runs twice", async () => {
		const { t, owner } = await ownerAndMember();
		const pageId = await owner.mutation(api.pages.create, { title: "Old notes" });
		const held = await holdPageWrite(t, owner, { page: pageId, trash: true }, "locked");
		const { resume, claimed } = await approveAndClaim(t, owner, held);
		expect(claimed).toMatchObject({ tool: "pages.write" });
		const op = { approval: held.approvalId };

		await t.mutation(internal.pageTools.writeFor, { turnId: resume, op, input: { page: pageId, trash: true } });
		expect((await pageOf(t, pageId))!.archived).toBe(true);
		expect(await approvalOf(t, held.approvalId)).toMatchObject({ status: "done" });
		const lines = await t.run((ctx) => ctx.db.query("agentActivity").collect());
		expect(lines.filter((l) => l.callId === `approval-${held.approvalId}`)).toHaveLength(1);

		// A retry of the same operation (a rerun, a duplicate delivery) finds the receipt and does nothing.
		await owner.mutation(api.trash.restore, { kind: "page", id: pageId });
		expect(await t.mutation(internal.pageTools.writeFor, { turnId: resume, op, input: { page: pageId, trash: true } })).toEqual({ error: expect.stringContaining("already ran") });
		expect((await pageOf(t, pageId))!.archived).toBe(false);
		// finish is a no-op once the write settled it.
		await t.mutation(internal.approvals.finish, { approvalId: held.approvalId, turnId: resume, error: "late" });
		expect(await approvalOf(t, held.approvalId)).toMatchObject({ status: "done" });
	});

	it("rechecks what the call depends on inside the effect's own transaction", async () => {
		const { t, owner } = await ownerAndMember();
		const pageId = await owner.mutation(api.pages.create, { title: "Plan" });
		const held = await holdPageWrite(t, owner, { page: pageId, markdown: "Fresh start", mode: "replace" }, "inside");
		const { resume, claimed } = await approveAndClaim(t, owner, held);
		expect(claimed).not.toBeNull();
		// Edited after the claim, before the write: the write itself refuses.
		await type(t, owner, pageId, "Edited by hand");
		const out = await t.mutation(internal.pageTools.writeFor, { turnId: resume, op: { approval: held.approvalId }, input: { page: pageId, mode: "replace" }, blocks: JSON.stringify([paragraph("Fresh start")]) });
		expect(out).toEqual({ error: expect.stringContaining("edited after it was approved") });
		expect(await t.run(async (ctx) => (await readDoc(ctx, pageId)).textContent)).toContain("Edited by hand");
		expect(await approvalOf(t, held.approvalId)).toMatchObject({ status: "failed" });
	});

	it("holds one approval per call id, however often it's requested", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
		await t.mutation(internal.turns.savePrompt, { turnId, prompt: "Reply" });
		const ask = () => t.mutation(internal.approvals.request, { turnId, callId: "c1", tool: "pages.write", input: canonicalJson({ title: "Plan" }), risk: "inside" });
		const first = await ask();
		expect((await ask()).approvalId).toBe(first.approvalId);
		expect(await t.run((ctx) => ctx.db.query("approvals").collect())).toHaveLength(1);
	});

	it("keys ordinary writes by their call id too, so a repeated call writes once", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
		const write = () => t.mutation(internal.pageTools.writeFor, { turnId, op: { call: "m1" }, input: { title: "Plan" } });
		expect(await write()).not.toHaveProperty("error");
		expect(await write()).toEqual({ error: expect.stringContaining("already ran") });
		expect((await t.run((ctx) => ctx.db.query("pages").collect())).filter((p) => p.title === "Plan")).toHaveLength(1);
		// A different call writes as usual.
		expect(await t.mutation(internal.pageTools.writeFor, { turnId, op: { call: "m2" }, input: { title: "Plan" } })).not.toHaveProperty("error");
	});

	it("claims an async built-in's key (making pictures) before it spends anything", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, (await generalOf(owner))._id, companybot._id);
		expect(await t.mutation(internal.approvals.startOp, { turnId, op: { call: "img" } })).toBeNull();
		expect(await t.mutation(internal.approvals.startOp, { turnId, op: { call: "img" } })).toContain("already ran");
	});
});

describe("connector writes and multi-step built-ins claim their call id", () => {
	const turnOf = async (t: T, as: As) => agentTurn(t, as, (await generalOf(as))._id, (await agentsOf(as)).companybot._id);

	it("answers a repeated connector write with its first result, or unknown if it never finished", async () => {
		const { t, owner } = await ownerAndMember();
		const turnId = await turnOf(t, owner);
		const start = (callId: string) => t.mutation(internal.approvals.startCall, { turnId, callId });
		expect(await start("c1")).toBeNull();
		expect(await start("c1")).toEqual({ error: expect.stringContaining("may or may not have happened") });
		await t.mutation(internal.approvals.finishCall, { turnId, callId: "c1", output: '{"sent":true}' });
		expect(await start("c1")).toEqual({ note: expect.stringContaining("already ran"), result: '{"sent":true}' });
	});

	it("saves a file from the web once per call id: one attachment, one receipt", async () => {
		const { t, owner } = await ownerAndMember();
		const turnId = await turnOf(t, owner);
		vi.useRealTimers();
		const save = () => t.action(internal.webFetch.saveFile, { turnId, url: "https://example.com/logo.png", op: { call: "s1" } });
		expect(await save()).toMatchObject({ name: "logo.png", type: "image/png" });
		expect(await save()).toEqual({ error: expect.stringContaining("already ran") });
		expect(safeFetch).toHaveBeenCalledTimes(1);
		const reply = await t.run(async (ctx) => ctx.db.get((await ctx.db.get("agentTurns", turnId))!.replyId!));
		expect(reply!.attachments).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.query("toolReceipts").collect())).toMatchObject([{ callId: "s1", state: "done" }]);
	});

	it("forgets done receipts after 30 days, a batch at a time, and keeps ones whose outcome is unknown", async () => {
		const { t, owner } = await ownerAndMember();
		const turnId = await turnOf(t, owner);
		for (let i = 1; i <= 12; i++) expect(await t.mutation(internal.pageTools.writeFor, { turnId, op: { call: `m${i}` }, input: { title: `Page ${i}` } })).not.toHaveProperty("error");
		await t.mutation(internal.approvals.startCall, { turnId, callId: "cut-off" });
		expect(await t.run((ctx) => ctx.db.query("toolReceipts").collect())).toHaveLength(13);
		vi.advanceTimersByTime(29 * 24 * 60 * 60 * 1000);
		await t.mutation(internal.approvals.forgetReceipts, {});
		expect(await t.run((ctx) => ctx.db.query("toolReceipts").collect())).toHaveLength(13);
		vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);
		await t.mutation(internal.approvals.forgetReceipts, {});
		await settle(t);
		expect(await t.run((ctx) => ctx.db.query("toolReceipts").collect())).toMatchObject([{ callId: "cut-off", state: "started" }]);
	});

	it("writes no receipt for a turn whose workspace is being deleted", async () => {
		const { t, owner } = await ownerAndMember();
		const turnId = await turnOf(t, owner);
		await t.run(async (ctx) => ctx.db.patch((await ctx.db.get("agentTurns", turnId))!.workspaceId, { deleting: true }));
		await expect(t.mutation(internal.approvals.startCall, { turnId, callId: "late" })).rejects.toThrow("stopped");
		expect(await t.run((ctx) => ctx.db.query("toolReceipts").collect())).toEqual([]);
	});
});

describe("record writes bind ids, not keys or labels", () => {
	async function setup() {
		const { t, owner } = await ownerAndMember();
		const typeId = await owner.mutation(api.recordTypes.create, { plural: "Projects" });
		const type = (await t.run((ctx) => ctx.db.get(typeId)))!;
		const priority = await owner.mutation(api.fields.create, { typeId, label: "Priority", kind: "text" });
		const stage = await owner.mutation(api.fields.create, { typeId, label: "Stage", kind: "choice", options: [{ label: "Won" }, { label: "Lost" }] });
		const record = await owner.mutation(api.records.create, { typeId, values: { name: "Roof" } });
		return { t, owner, typeId, key: type.key, priority, stage, record };
	}

	it("won't archive a field made again with the same key after the approval", async () => {
		const s = await setup();
		const held = await holdCall(s.t, s.owner, "records.save_field", { type: s.key, field: s.priority.key, trash: true }, "locked");
		await approve(s.owner, held.approvalId, held.card.hash);
		await s.owner.mutation(api.trash.move, { kind: "field", id: s.priority._id });
		await s.owner.mutation(api.trash.purge, { id: s.priority._id });
		// Run the purge's cascade, not the scheduled reply that would run the approved call.
		await s.t.run(async (ctx) => {
			for (const job of await ctx.db.system.query("_scheduled_functions").collect()) if (job.state.kind === "pending" && job.name.startsWith("agent")) await ctx.scheduler.cancel(job._id);
		});
		await settle(s.t);
		const again = await s.owner.mutation(api.fields.create, { typeId: s.typeId, label: "Priority", kind: "text" });
		expect(again.key).toBe(s.priority.key);
		const resume = (await turnsOf(s.t)).at(-1)!._id;
		expect(await s.t.mutation(internal.approvals.claim, { approvalId: held.approvalId, turnId: resume })).toBeNull();
		expect(await approvalOf(s.t, held.approvalId)).toMatchObject({ status: "failed", error: expect.stringContaining("edited after it was approved") });
		expect((await s.t.run((ctx) => ctx.db.get(again._id)))!.archived).toBe(false);
	});

	it("won't set a choice whose label moved to another option", async () => {
		const s = await setup();
		const held = await holdCall(s.t, s.owner, "records.save", { id: s.record, values: { [s.stage.key]: "Won" } }, "inside");
		await approve(s.owner, held.approvalId, held.card.hash);
		const [won, lost] = s.stage.options!;
		await s.owner.mutation(api.fields.update, { fieldId: s.stage._id, options: [{ id: won!.id, label: "Lost" }, { id: lost!.id, label: "Won" }] });
		const resume = (await turnsOf(s.t)).at(-1)!._id;
		expect(await s.t.mutation(internal.approvals.claim, { approvalId: held.approvalId, turnId: resume })).toBeNull();
	});

	it("won't archive a field or database that gained a record since the approval", async () => {
		for (const [tool, input] of [["records.save_field", (s: Awaited<ReturnType<typeof setup>>) => ({ type: s.key, field: s.priority.key, trash: true })], ["records.save_database", (s: Awaited<ReturnType<typeof setup>>) => ({ type: s.key, trash: true })]] as const) {
			const s = await setup();
			const held = await holdCall(s.t, s.owner, tool, input(s), "locked");
			await approve(s.owner, held.approvalId, held.card.hash);
			await s.owner.mutation(api.records.create, { typeId: s.typeId, values: { name: "Added later" } });
			const resume = (await turnsOf(s.t)).at(-1)!._id;
			expect(await s.t.mutation(internal.approvals.claim, { approvalId: held.approvalId, turnId: resume })).toBeNull();
		}
	});

	it("runs when nothing it names changed", async () => {
		const s = await setup();
		const held = await holdCall(s.t, s.owner, "records.save", { id: s.record, values: { [s.stage.key]: "Won" } }, "inside");
		const { resume, claimed } = await approveAndClaim(s.t, s.owner, held);
		expect(claimed).not.toBeNull();
		expect(await s.t.mutation(internal.recordTools.saveFor, { turnId: resume, op: { approval: held.approvalId }, input: { id: s.record, values: { [s.stage.key]: "Won" } } })).not.toHaveProperty("error");
		expect(await approvalOf(s.t, held.approvalId)).toMatchObject({ status: "done" });
	});
});

describe("nothing leaves the workspace unseen after a restricted read", () => {
	/** Dana (Office) can see Deals; others in #general can't. */
	async function setup() {
		const { t, owner, member: crew } = await ownerAndMember();
		await owner.mutation(api.workspace.invite, { email: "dana@co.com", role: "member" });
		const dana = await signIn(t, "dana@co.com");
		const office = await owner.mutation(api.roles.create, { name: "Office" });
		const team = (await owner.query(api.workspace.team))!.members;
		await owner.mutation(api.workspace.setRoles, { id: team.find((m) => m.userId === dana.userId)!.id, roles: [office] });
		const deals = (await owner.query(api.recordTypes.list)).find((d) => d.key === "deal")!._id;
		const deal = await owner.mutation(api.records.create, { typeId: deals, values: { name: "Quartz: $91,000" } });
		await owner.mutation(api.recordTypes.setAccess, { typeId: deals, access: [{ role: office, level: "view" }] });
		const { companybot } = await agentsOf(owner);
		const start = (chatId: Id<"chats">, as: As = dana) => agentTurn(t, as, chatId, companybot._id);
		/** As the runner asks: `readOnly` is core `readsOnly` of the live tool. */
		const check = (turnId: Id<"agentTurns">, action = "web.search", risk: "none" | "inside" | "outside" | "locked" = "none", readOnly = false) =>
			t.mutation(internal.permissions.check, { turnId, action, risk, sendsOut: true, readOnly });
		return { t, owner, crew, dana, companybot, deal, start, check, general: (await generalOf(owner))._id };
	}
	const asks = { decision: { type: "ask", canAlways: false }, risk: "locked" };

	it("runs freely until the reply reads something restricted, then asks for each exact call, with no Always", async () => {
		const s = await setup();
		const turnId = await s.start(s.general);
		expect(await s.check(turnId)).toMatchObject({ decision: { type: "run" }, risk: "none" });
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		expect(await s.check(turnId)).toMatchObject(asks);
		// Not sending out (a built-in read) is unaffected.
		expect(await s.t.mutation(internal.permissions.check, { turnId, action: "memory.search", risk: "none" })).toMatchObject({ decision: { type: "run" } });

		// The card holds the exact query, and approving binds it: a different query isn't approved.
		await s.t.mutation(internal.turns.savePrompt, { turnId, prompt: "Reply to this message" });
		const input = { query: "Quartz contract benchmarks" };
		const { approvalId } = await s.t.mutation(internal.approvals.request, { turnId, callId: "w1", tool: "web.search", input: canonicalJson(input), risk: "locked" });
		await s.t.mutation(internal.turns.updateReply, { turnId, text: "", parts: [{ type: "approval", id: "w1", approvalId, tool: "web.search" }] });
		await s.t.mutation(internal.turns.finishReply, { turnId });
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		const [card] = await s.dana.query(api.approvals.forReply, { replyId });
		expect(card).toMatchObject({ input: canonicalJson(input), hash: await approvalHash("web.search", input) });
		await expect(approve(s.dana, approvalId, await approvalHash("web.search", { query: "something else" }))).rejects.toThrow("isn't the one you were shown");
		// Others in #general can't see the private reply's card at all.
		expect(await s.crew.query(api.approvals.forReply, { replyId })).toEqual([]);
	});

	it("asks in a private channel or group DM even before reading anything: outside is wider than any chat", async () => {
		const s = await setup();
		const room = await s.owner.mutation(api.chats.createChannel, { name: "board", private: true });
		expect(await s.check(await s.start(room, s.owner))).toMatchObject(asks);
		await s.t.mutation(internal.turns.finishReply, { turnId: (await turnsOf(s.t)).at(-1)!._id });
		const group = await s.dana.mutation(api.chats.openDm, { userIds: [s.crew.userId], agentIds: [s.companybot._id] });
		expect(await s.check(await s.start(group))).toMatchObject(asks);
	});

	it("in your own agent DM, your own data doesn't count, but anyone else's restricted place still does", async () => {
		const s = await setup();
		const dm = await s.dana.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const turnId = await s.start(dm);
		expect(await s.check(turnId)).toMatchObject({ decision: { type: "run" }, risk: "none" });
		await s.t.mutation(internal.memory.createFor, { turnId, scope: "personal", content: "I like short replies" });
		await s.t.mutation(internal.memory.searchFor, { turnId, query: "short replies" });
		expect(await s.check(turnId)).toMatchObject({ decision: { type: "run" }, risk: "none" });
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		expect(await s.check(turnId)).toMatchObject(asks);
	});

	/** CRM (workspace, Owners only, with tools listed) and Notes (personal), both connected by the owner. */
	async function connectors() {
		const s = await setup();
		for (const connectorId of ["crm", "notes"]) {
			await s.owner.mutation(api.connectors.setInstalled, { connectorId, installed: true });
			await s.owner.action(api.connectors.connect, { connectorId, credentials: { type: "api_key", key: "fixture-key" } });
		}
		await s.owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [] });
		const installs = await s.t.run((ctx) => ctx.db.query("connectorInstalls").collect());
		for (const install of installs) {
			const tools = install.connectorId === "crm"
				? [
						{ name: "find_leads", description: "Find leads", risk: "none" as const },
						{ name: "search", description: "Search", risk: "none" as const },
						{ name: "send_email", description: "Email anyone", risk: "outside" as const },
						{ name: "charge_card", description: "Charge a card", risk: "locked" as const },
						// readOnlyHint and destructiveHint both: destructive wins (core mcp.ts).
						{ name: "wipe", description: "Wipe leads", risk: "locked" as const },
					]
				: [{ name: "add_note", description: "Add a note", risk: "outside" as const }];
			await s.t.mutation(internal.connectorTools.saveTools, { workspaceId: install.workspaceId, connectorId: install.connectorId, installId: install._id, tools });
		}
		const turnId = await s.start(s.general, s.owner);
		const read = (connectorId: string) => s.t.mutation(internal.connectors.forCall, { turnId, connectorId });
		return { ...s, turnId, read };
	}

	it("after reading an Owner-only workspace connector, any other connector or the web asks with the exact payload", async () => {
		const s = await connectors();
		expect(await s.check(s.turnId, "notes.add_note", "outside")).toMatchObject({ decision: { type: "ask", canAlways: true }, risk: "outside" });
		expect(await s.read("crm")).not.toBeNull();
		expect(await s.check(s.turnId, "notes.add_note", "outside")).toMatchObject(asks);
		expect(await s.check(s.turnId)).toMatchObject(asks);
		// Reading more from the same CRM stays within the CRM's audience.
		expect(await s.check(s.turnId, "crm.find_leads", "none", true)).toMatchObject({ decision: { type: "run" }, risk: "none" });
	});

	it("exempts only read-only calls to the same connector: a send through it asks, even with Always", async () => {
		const s = await connectors();
		await s.owner.mutation(api.permissions.set, { action: "crm.send_email", setting: "always" });
		expect(await s.check(s.turnId, "crm.send_email", "outside")).toMatchObject({ decision: { type: "run", via: "always" } });
		await s.read("crm");
		expect(await s.check(s.turnId, "crm.send_email", "outside")).toMatchObject(asks);
		expect(await s.check(s.turnId, "crm.search", "none", true)).toMatchObject({ decision: { type: "run" }, risk: "none" });
		// Read-only on both sides, or it's a write: a tool the server hasn't listed, one listed as destructive
		// though the call claims a read, or a listed read the live tool no longer calls read-only.
		expect(await s.check(s.turnId, "crm.unlisted", "none", true)).toMatchObject(asks);
		expect(await s.check(s.turnId, "crm.wipe", "none", true)).toMatchObject(asks);
		expect(await s.check(s.turnId, "crm.search", "none", false)).toMatchObject(asks);
	});

	it("isn't lifted by an Unlocked action or an Always rule", async () => {
		const s = await connectors();
		await s.owner.mutation(api.permissions.setLock, { action: "crm.charge_card", lock: "none" });
		await s.owner.mutation(api.permissions.set, { action: "crm.charge_card", setting: "always" });
		expect(await s.check(s.turnId, "crm.charge_card", "locked")).toMatchObject({ decision: { type: "run", via: "always" } });
		// A personal connector's data is only the owner's: in #general, it's restricted.
		expect(await s.read("notes")).not.toBeNull();
		expect(await s.check(s.turnId, "crm.charge_card", "locked")).toMatchObject(asks);
		// A block still wins.
		await s.owner.mutation(api.permissions.setLock, { action: "crm.charge_card", lock: "block" });
		expect(await s.check(s.turnId, "crm.charge_card", "locked")).toMatchObject({ decision: { type: "deny" } });
	});
});
