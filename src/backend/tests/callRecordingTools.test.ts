import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { agentTurn, agentsOf, ownerAndMember, setMemberSwitch, signIn, workspaceOf } from "./helpers";

async function fixture() {
	vi.useFakeTimers();
	const { t, owner, member } = await ownerAndMember();
	const { companybot } = await agentsOf(owner);
	const workspaceId = await workspaceOf(owner);
	const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const memberDm = await member.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const ownerTurn = await agentTurn(t, owner, dm, companybot._id);
	const memberTurn = await agentTurn(t, member, memberDm, companybot._id);
	const data = await t.run(async ctx => {
		const pointId = await ctx.db.insert("contactPoints", { workspaceId, agentId: companybot._id, kind: "phone", address: "+15125550100", status: "active", createdBy: owner.userId });
		const conversationId = await ctx.db.insert("inboxConversations", { workspaceId, agentId: companybot._id, channel: "call", contact: "+15125550199", mode: "staff", lastAt: Date.now(), preview: "Outgoing call" });
		const id = await ctx.db.insert("inboxMessages", { workspaceId, conversationId, direction: "out", status: "sent", text: "Outgoing call", call: { room: "private-room", pointId, from: "+15125550100", active: false, state: "completed", declined: [], rateUsd: 0.05, connectedAt: Date.now() - 20_000, endedAt: Date.now(), recording: { status: "ready", key: "private-storage-key" }, transcript: { status: "ready" }, summary: { status: "ready", text: "The customer requested a quote." } } });
		const text = "A".repeat(12_000) + "Call back Tuesday.";
		await ctx.db.insert("callTranscripts", { workspaceId, conversationId, messageId: id, text });
		return { id, conversationId, text };
	});
	const call = (request: unknown, asMember = false): Promise<any> => t.mutation(internal.manageTools.runFor, { turnId: asMember ? memberTurn : ownerTurn, tool: "inbox.manage", input: { request } });
	return { t, owner, member, companybot, workspaceId, call, ...data };
}

afterEach(() => vi.useRealTimers());

describe("call recordings through the agent's Inbox tool", () => {
	it("reads transcripts lazily in bounded pages and leaves private storage addresses out of tool results", async () => {
		const { call, id, conversationId, text } = await fixture();
		const history = await call({ action: "read", id: conversationId });
		expect(history.messages[0].call).toMatchObject({ id, transcript: { status: "ready", text: null }, summary: { text: "The customer requested a quote." } });
		expect(JSON.stringify(history)).not.toContain(text);
		const first = await call({ action: "read_call", id });
		expect(first.transcript).toEqual({ text: text.slice(0, 12_000), offset: 0, nextOffset: 12_000 });
		const last = await call({ action: "read_call", id, offset: first.transcript.nextOffset });
		expect(last.transcript).toEqual({ text: "Call back Tuesday.", offset: 12_000, nextOffset: null });
		expect(JSON.stringify(first)).not.toContain("private-storage-key");
	});

	it("rechecks Inbox permission for reading or retrying after a turn has begun", async () => {
		const { owner, call, id } = await fixture();
		expect((await call({ action: "read_call", id }, true)).transcript.text).toHaveLength(12_000);
		await setMemberSwitch(owner, "inbox.use", false);
		for (const action of ["read_call", "retry_call_processing"])
			expect(await call({ action, id }, true)).toHaveProperty("error");
	});

	it("never reads or retries a different workspace's call", async () => {
		const { t, call, id } = await fixture();
		const other = await signIn(t, "other-call-tool@companybot.test");
		const otherWorkspace = await workspaceOf(other);
		// Even a forged ownership field cannot make the call cross its conversation's workspace.
		await t.run(ctx => ctx.db.patch(id, { workspaceId: otherWorkspace }));
		for (const action of ["read_call", "retry_call_processing"])
			expect(await call({ action, id })).toHaveProperty("error");
	});
});
