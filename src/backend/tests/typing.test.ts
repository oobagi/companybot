import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { agentTurn, agentsOf, generalOf, noMentions, setup } from "./helpers";

afterEach(() => void vi.useRealTimers());

describe("typing", () => {
	it("shows who's typing to others, per place, until they send", async () => {
		const { owner, member } = await setup();
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
		const { owner, member } = await setup();
		const secret = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		await owner.mutation(api.typing.ping, { chatId: secret });
		expect(await member.query(api.typing.list, { chatId: secret })).toEqual({ people: [], agents: [] });
		await expect(member.mutation(api.typing.ping, { chatId: secret })).rejects.toThrow("not found");
	});

	it("shows an agent as typing while its turn runs, not once it's stuck", async () => {
		const { t, owner } = await setup();
		const general = (await generalOf(owner))._id;
		const { companybot } = await agentsOf(owner);
		const turnId = await agentTurn(t, owner, general, companybot._id);
		expect((await owner.query(api.typing.list, { chatId: general })).agents.map((a) => a.name)).toEqual(["Companybot"]);
		await t.run((ctx) => ctx.db.patch(turnId, { startedAt: Date.now() - 6 * 60_000 }));
		expect((await owner.query(api.typing.list, { chatId: general })).agents).toEqual([]);
	});

	it("shows only recent pings, however many people typed and never sent", async () => {
		const { t, owner, member } = await setup();
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
		const { t, owner } = await setup();
		const { companybot } = await agentsOf(owner);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.typing.ping, { chatId: dm });
		const general = (await generalOf(owner))._id;
		const elsewhere = await owner.mutation(api.chats.createChannel, { name: "ops", private: false });
		const other = await owner.mutation(api.messages.send, { chatId: elsewhere, text: "hi", mentions: noMentions });
		await owner.mutation(api.typing.ping, { chatId: general, threadId: other });
		expect(await t.run((ctx) => ctx.db.query("typing").collect())).toEqual([]);
	});
});
