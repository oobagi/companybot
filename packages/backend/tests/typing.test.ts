import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { agentTurn, agentsOf, generalOf, noMentions, ownerAndMember } from "./helpers";

// No network: the runner's model call is stubbed with a scripted stream.
const streamText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), streamText }));

afterEach(() => void vi.useRealTimers());

describe("typing", () => {
	it("shows who's typing to others, per place, until they send", async () => {
		const { owner, member } = await ownerAndMember();
		const general = (await generalOf(owner))._id;
		await member.mutation(api.typing.ping, { chatId: general });
		await member.mutation(api.typing.ping, { chatId: general });
		expect((await owner.query(api.typing.list, { chatId: general })).people.map((p) => p.name)).toEqual(["member@co.com"]);
		// Not to themselves, and not in a thread of the same chat.
		expect((await member.query(api.typing.list, { chatId: general })).people).toEqual([]);
		const parent = await owner.mutation(api.messages.send, { chatId: general, text: "hi", mentions: noMentions });
		expect((await owner.query(api.typing.list, { chatId: general, threadId: parent })).people).toEqual([]);

		await member.mutation(api.messages.send, { chatId: general, text: "done", mentions: noMentions });
		expect((await owner.query(api.typing.list, { chatId: general })).people).toEqual([]);
	});

	it("never shows typing in a chat you can't see", async () => {
		const { owner, member } = await ownerAndMember();
		const secret = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		await owner.mutation(api.typing.ping, { chatId: secret });
		expect(await member.query(api.typing.list, { chatId: secret })).toEqual({ people: [], agents: [] });
		await expect(member.mutation(api.typing.ping, { chatId: secret })).rejects.toThrow("not found");
	});

	it("shows an agent as typing while its turn runs, not once it's stuck", async () => {
		const { t, owner } = await ownerAndMember();
		const general = (await generalOf(owner))._id;
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, general, companybot._id);
		expect((await owner.query(api.typing.list, { chatId: general })).agents.map((a) => a.name)).toEqual(["Companybot"]);
		await t.run((ctx) => ctx.db.patch(turnId, { startedAt: Date.now() - 6 * 60_000 }));
		expect((await owner.query(api.typing.list, { chatId: general })).agents).toEqual([]);
	});

	it("shows only recent pings, however many people typed and never sent", async () => {
		const { t, owner, member } = await ownerAndMember();
		const general = (await generalOf(owner))._id;
		await t.run(async (ctx) => {
			const chat = (await ctx.db.get(general))!;
			const old = Date.now() - 60_000;
			for (let i = 0; i < 30; i++) {
				const userId = await ctx.db.insert("users", { email: `idle${i}@co.com` });
				await ctx.db.insert("typing", { workspaceId: chat.workspaceId, chatId: general, userId, at: old });
			}
		});
		await member.mutation(api.typing.ping, { chatId: general });
		expect((await owner.query(api.typing.list, { chatId: general })).people.map((p) => p.name)).toEqual(["member@co.com"]);
		await t.mutation(internal.typing.forgetStale, {});
		expect(await t.run((ctx) => ctx.db.query("typing").collect())).toHaveLength(1);
	});

	it("ignores pings nobody could see: agent DMs, and threads that aren't one", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.typing.ping, { chatId: dm });
		const general = (await generalOf(owner))._id;
		const elsewhere = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
		const other = await owner.mutation(api.messages.send, { chatId: elsewhere, text: "hi", mentions: noMentions });
		await owner.mutation(api.typing.ping, { chatId: general, threadId: other });
		expect(await t.run((ctx) => ctx.db.query("typing").collect())).toEqual([]);
	});

	it("shows each step of a running turn as it happens, then nothing once it's done", async () => {
		const { t, owner } = await ownerAndMember();
		const general = (await generalOf(owner))._id;
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, general, companybot._id);
		vi.useRealTimers();
		// What the line under the composer says after each part of the model's stream.
		const seen: (string | null)[] = [];
		const look = async () => seen.push((await owner.query(api.typing.list, { chatId: general })).agents[0]?.step ?? null);
		streamText.mockReturnValue({
			stream: (async function* () {
				yield { type: "start-step" };
				await look();
				yield { type: "tool-call", toolCallId: "c1", toolName: "memory_search", input: { query: "Acme" } };
				await look();
				yield { type: "tool-result", toolCallId: "c1", toolName: "memory_search", input: { query: "Acme" }, output: [] };
				await look();
				yield { type: "start-step" };
				yield { type: "text-delta", text: "Nothing on Acme yet." };
				await look();
			})(),
		});
		await t.action(internal.agent.respond, { turnId });
		expect(seen).toEqual(["Thinking…", "Searching memory…", "Thinking…", null]);
		expect((await owner.query(api.typing.list, { chatId: general })).agents).toEqual([]);
		expect((await t.run((ctx) => ctx.db.get("agentTurns", turnId)))?.step).toBeUndefined();
	});

	it("keeps the step on the turn, so a run that posts nothing still shows it, and drops it once it ends", async () => {
		const { t, owner } = await ownerAndMember();
		const general = (await generalOf(owner))._id;
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, general, companybot._id);
		await t.run(async (ctx) => ctx.db.delete((await ctx.db.get("agentTurns", turnId))!.replyId!));
		await t.mutation(internal.turns.setStep, { turnId, label: "Checking the calendar…" });
		expect((await owner.query(api.typing.list, { chatId: general })).agents).toMatchObject([{ name: "Companybot", step: "Checking the calendar…" }]);
		await t.mutation(internal.turns.finishReply, { turnId });
		await t.mutation(internal.turns.setStep, { turnId, label: "Too late…" });
		expect((await t.run((ctx) => ctx.db.get("agentTurns", turnId)))?.step).toBeUndefined();
	});

	it("lists every agent working in a place with its step, only to people who can see it", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot, scribe } = await agentsOf(owner);
		const board = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		const first = await agentTurn(t, owner, board, companybot._id);
		await agentTurn(t, owner, board, scribe._id);
		await t.mutation(internal.turns.setStep, { turnId: first, label: "Searching records for Acme…" });
		expect((await owner.query(api.typing.list, { chatId: board })).agents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "Companybot", step: "Searching records for Acme…" }),
				expect.objectContaining({ name: "Scribe", step: null }),
			]),
		);
		expect(await member.query(api.typing.list, { chatId: board })).toEqual({ people: [], agents: [] });
	});
});
