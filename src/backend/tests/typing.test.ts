import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
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

	it("shows an agent as typing while its turn runs", async () => {
		const { t, owner } = await setup();
		const general = (await generalOf(owner))._id;
		const { companybot } = await agentsOf(owner);
		await agentTurn(t, owner, general, companybot._id);
		expect((await owner.query(api.typing.list, { chatId: general })).agents.map((a) => a.name)).toEqual(["Companybot"]);
	});
});
