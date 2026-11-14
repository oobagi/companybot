import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { agentTurn, agentsOf, ownerAndMember, setMemberSwitch, sideWorkspace, workspaceOf } from "./helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
async function fixture(channel: "email" | "sms" | "call" = "call") {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const { companybot } = await agentsOf(owner);
	const id = await t.run(ctx => ctx.db.insert("inboxConversations", {
		workspaceId, agentId: companybot._id, channel, contact: channel === "email" ? "customer@example.com" : "+14155550199",
		mode: "staff", takenBy: member.userId, needsStaff: "handoff", lastAt: Date.now(), preview: "Waiting for staff",
	}));
	return { t, owner, member, workspaceId, agentId: companybot._id, id };
}

describe("unassigned Inbox conversations", () => {
	it.each(["email", "sms", "call"] as const)("lets staff unassign themselves from %s without losing its pending hand-off", async channel => {
		const { t, member, id } = await fixture(channel);
		expect((await member.query(api.inbox.list))!.find(c => c.id === id)!.mine).toBe(true);
		await member.mutation(api.inbox.assign, { id, to: null });
		const conversation = (await member.query(api.inbox.get, { id }))!;
		expect(conversation).toMatchObject({ mode: "staff", takenBy: null, needsStaff: "handoff" });
		expect(conversation.messages).toHaveLength(1);
		expect(conversation.messages[0]).toMatchObject({ direction: "event", assignedTo: null, unassigned: true, author: { id: member.userId } });
		expect((await member.query(api.inbox.list))!.find(c => c.id === id)).toMatchObject({ mine: false, assignee: null });
		await member.mutation(api.inbox.assign, { id, to: null });
		expect((await member.query(api.inbox.get, { id }))!.messages).toHaveLength(1);
		expect(await t.mutation(internal.inboxAgent.begin, { conversationId: id })).toBeNull();
	});

	it("can leave an agent-handled conversation unassigned and later give it to a teammate", async () => {
		const { t, owner, member, id } = await fixture("email");
		await owner.mutation(api.inbox.assign, { id, to: "agent" });
		await owner.mutation(api.inbox.assign, { id, to: null });
		expect(await t.mutation(internal.inboxAgent.begin, { conversationId: id })).toBeNull();
		await owner.mutation(api.inbox.assign, { id, to: member.userId });
		expect((await member.query(api.inbox.get, { id }))!.takenBy?.id).toBe(member.userId);
	});

	it("enforces Inbox permission and the active workspace when removing an assignment", async () => {
		const { t, owner, member, id } = await fixture();
		const { workspaceId } = await sideWorkspace(t, "owner@co.com");
		await expect(owner.in(workspaceId).mutation(api.inbox.assign, { id, to: null })).rejects.toThrow();
		await setMemberSwitch(owner, "inbox.use", false);
		await expect(member.mutation(api.inbox.assign, { id, to: null })).rejects.toThrow();
		expect((await t.run(ctx => ctx.db.get(id)))!.takenBy).toBe(member.userId);
	});

	it("lets the agent remove an assignment through the same authorized Inbox tool", async () => {
		const { t, owner, member, agentId, id } = await fixture();
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [agentId] });
		const turnId = await agentTurn(t, owner, dm, agentId);
		const run = (request: unknown): Promise<any> => t.mutation(internal.manageTools.runFor, { turnId, tool: "inbox.manage", input: { request } });
		expect(await run({ action: "assign", id, to: null })).toMatchObject({ done: "assign", to: null });
		expect((await member.query(api.inbox.get, { id }))!.takenBy).toBeNull();
		const result = await run({ action: "read", id });
		expect(result.messages.at(-1)).toHaveProperty("assignedTo", null);
	});
});
