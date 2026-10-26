import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

import { agentsOf, setup as ownerAndMember, generalOf, turnsOf, agentTurn } from "./helpers";

// The tests drive turns themselves; keep scheduled model replies back.
beforeEach(() => void vi.useFakeTimers());

afterEach(() => void vi.useRealTimers());

describe("activity log", () => {
	const mention = (agentId: Id<"agents">) => ({ userIds: [], agentIds: [agentId] });
	const call = { callId: "c1", tool: "memory.remember_for_team", changes: true, input: '{"content":"x"}', output: '{"id":"m1"}' };

	it("shows calls to whoever can see the chat, and results only to the person", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = (await generalOf(owner))._id;
		await owner.mutation(api.messages.send, { chatId, text: "@Companybot remember x", mentions: mention(companybot._id) });
		const [turn] = await turnsOf(t);
		await t.mutation(internal.activity.log, { turnId: turn!._id, ...call });

		expect(await owner.query(api.activity.list, {})).toMatchObject([
			{ agent: "Companybot", tool: call.tool, chat: "#general", mine: true, output: call.output, status: "done" },
		]);
		const [theirs] = await member.query(api.activity.list, {});
		expect(theirs).toMatchObject({ mine: false, input: call.input, actor: "owner@co.com" });
		expect(theirs!.output).toBeUndefined();
		expect(await member.query(api.activity.forReply, { replyId: turn!.replyId! })).toHaveLength(1);
	});

	it("hides calls from chats the person can't see", async () => {
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const chatId = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		await owner.mutation(api.messages.send, { chatId, text: "@Companybot hi", mentions: mention(companybot._id) });
		const [turn] = await turnsOf(t);
		await t.mutation(internal.activity.log, { turnId: turn!._id, ...call, output: undefined, error: "Nope" });

		expect(await owner.query(api.activity.list, {})).toMatchObject([{ status: "error", error: "Nope", chat: "#board" }]);
		expect(await member.query(api.activity.list, {})).toEqual([]);
		expect(await member.query(api.activity.forReply, { replyId: turn!.replyId! })).toEqual([]);
	});

	it("marks memories an agent changed until a person edits them", async () => {
		const { t, owner } = await ownerAndMember();
		const agentId = (await agentsOf(owner)).companybot._id;
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
		const made = await t.mutation(internal.memory.createFor, { turnId: await agentTurn(t, owner, dm, agentId), scope: "personal", content: "Likes tea." });
		expect((await owner.query(api.memory.list))[0]).toMatchObject({ updatedByAgent: true });
		await owner.mutation(api.memory.update, { id: made.id as Id<"memories">, content: "Likes coffee.", expectedVersion: 1 });
		expect((await owner.query(api.memory.list))[0]!.updatedByAgent).toBeUndefined();
	});
});
