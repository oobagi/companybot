import { approvalHash, canonicalJson } from "@companybot/core";
import { Transform } from "@tiptap/pm/transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { pageSchema, sync } from "../convex/pageOps";
import { type As, agentTurn, agentsOf, generalOf, identityOf, ownerAndMember, signIn, turnsOf } from "./helpers";

// Agent safety (#215): approvals name what they change by id and bind the revision they were shown, an
// approved call commits its effect with its receipt once, and nothing leaves the workspace unseen after a
// reply read something its chat can't all see. No network: the runner's model call is a scripted stream.
const streamText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), streamText }));

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
});

type T = Awaited<ReturnType<typeof ownerAndMember>>["t"];

/** `as` asks Companybot in #general and its reply holds `input` for pages.write. Returns the card. */
async function holdPageWrite(t: T, as: As, input: object, risk: "inside" | "locked") {
	const { companybot } = await agentsOf(as);
	const turnId = await agentTurn(t, as, (await generalOf(as))._id, companybot._id);
	await t.mutation(internal.turns.savePrompt, { turnId, prompt: "Reply to this message" });
	const { approvalId } = await t.mutation(internal.approvals.request, { turnId, callId: "c1", tool: "pages.write", input: canonicalJson(input), risk });
	await t.mutation(internal.turns.updateReply, { turnId, text: "", parts: [{ type: "approval", id: "c1", approvalId, tool: "pages.write" }] });
	await t.mutation(internal.turns.finishReply, { turnId });
	const replyId = (await t.run((ctx) => ctx.db.get(turnId)))!.replyId!;
	const [card] = await as.query(api.approvals.forReply, { replyId });
	return { turnId, approvalId, card: card! };
}
const approve = (as: As, approvalId: Id<"approvals">, hash: string) => as.mutation(api.approvals.decide, { approvalId, hash, approve: true, always: false });
const approvalOf = (t: T, id: Id<"approvals">) => t.run((ctx) => ctx.db.get(id));
const pageOf = (t: T, id: Id<"pages">) => t.run((ctx) => ctx.db.get(id));

/** Types `text` into the page as `as`'s editor does. */
async function type(t: T, as: As, pageId: Id<"pages">, text: string) {
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
		const { approvalId, card } = await holdPageWrite(t, owner, { page: pageId, trash: true }, "locked");
		await approve(owner, approvalId, card.hash);
		const resume = (await turnsOf(t)).at(-1)!;
		const claimed = await t.mutation(internal.approvals.claim, { approvalId, turnId: resume._id });
		expect(claimed).toMatchObject({ tool: "pages.write" });

		await t.mutation(internal.pageTools.writeFor, { turnId: resume._id, op: approvalId, input: { page: pageId, trash: true } });
		expect((await pageOf(t, pageId))!.archived).toBe(true);
		expect(await approvalOf(t, approvalId)).toMatchObject({ status: "done" });
		const lines = await t.run((ctx) => ctx.db.query("agentActivity").collect());
		expect(lines.filter((l) => l.callId === `approval-${approvalId}`)).toHaveLength(1);

		// A retry of the same operation (a rerun, a duplicate delivery) finds the receipt and does nothing.
		await owner.mutation(api.trash.restore, { kind: "page", id: pageId });
		await expect(t.mutation(internal.pageTools.writeFor, { turnId: resume._id, op: approvalId, input: { page: pageId, trash: true } })).rejects.toThrow("already ran");
		expect((await pageOf(t, pageId))!.archived).toBe(false);
		// finish is a no-op once the write settled it.
		await t.mutation(internal.approvals.finish, { approvalId, turnId: resume._id, error: "late" });
		expect(await approvalOf(t, approvalId)).toMatchObject({ status: "done" });
	});
});

describe("web calls after a restricted read", () => {
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
		const start = (chatId: Id<"chats">) => agentTurn(t, dana, chatId, companybot._id);
		const search = (turnId: Id<"agentTurns">) => t.mutation(internal.permissions.check, { turnId, action: "web.search", risk: "none", sendsOut: true });
		return { t, owner, crew, dana, companybot, deal, start, search, general: (await generalOf(owner))._id };
	}

	it("runs freely until the reply reads something the chat can't all see, then asks for each exact call, with no Always", async () => {
		const s = await setup();
		const turnId = await s.start(s.general);
		expect(await s.search(turnId)).toMatchObject({ decision: { type: "run" }, risk: "none" });
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		expect(await s.search(turnId)).toMatchObject({ decision: { type: "ask", canAlways: false }, risk: "locked" });
		// Not sending out (a built-in read) is unaffected.
		expect(await s.t.mutation(internal.permissions.check, { turnId, action: "memory.search", risk: "none" })).toMatchObject({ decision: { type: "run" } });

		// The card holds the exact query, and approving binds it: a different query isn't approved.
		await s.t.mutation(internal.turns.savePrompt, { turnId, prompt: "Reply to this message" });
		const input = { query: "Quartz contract benchmarks" };
		const { approvalId } = await s.t.mutation(internal.approvals.request, { turnId, callId: "w1", tool: "web.search", input: canonicalJson(input), risk: "locked" });
		await s.t.mutation(internal.turns.updateReply, { turnId, text: "", parts: [{ type: "approval", id: "w1", approvalId, tool: "web.search" }] });
		await s.t.mutation(internal.turns.finishReply, { turnId });
		const replyId = (await s.t.run((ctx) => ctx.db.get(turnId)))!.replyId!;
		const [card] = await s.dana.query(api.approvals.forReply, { replyId });
		expect(card).toMatchObject({ input: canonicalJson(input), hash: await approvalHash("web.search", input) });
		await expect(approve(s.dana, approvalId, await approvalHash("web.search", { query: "something else" }))).rejects.toThrow("isn't the one you were shown");
		// Others in #general can't see the private reply's card at all.
		expect(await s.crew.query(api.approvals.forReply, { replyId })).toEqual([]);
	});

	it("stays free in a chat whose audience can already see what was read", async () => {
		const s = await setup();
		const dm = await s.dana.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const turnId = await s.start(dm);
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		expect(await s.search(turnId)).toMatchObject({ decision: { type: "run" }, risk: "none" });
	});
});
