import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentTurn, agentsOf, noMentions, ownerAndMember, workspaceOf } from "./helpers";

afterEach(() => vi.useRealTimers());

it("reacts, edits a topic and adds a member in a 300-person private chat with three deep sources", async () => {
	vi.useFakeTimers();
	const { t, owner } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const { companybot } = await agentsOf(owner);
	const memberRole = (await owner.query(api.roles.list))!.find((r) => r.name === "Member")!.id;
	const chatId = await owner.mutation(api.chats.createChannel, { name: "large-private", private: true });
	const extra = await t.run(async (ctx) => {
		let extra!: Id<"users">;
		for (let i = 0; i < 300; i++) {
			const userId = await ctx.db.insert("users", { email: `reader${i}@co.com` });
			await ctx.db.insert("members", { workspaceId, userId, roles: [memberRole], name: `reader${i}@co.com`, timeZone: "UTC" });
			if (i < 299) await ctx.db.insert("chatMembers", { workspaceId, chatId, userId });
			else extra = userId;
		}
		return extra;
	});
	const sources = await t.run(async (ctx) => {
		const sources: Id<"pages">[] = [];
		for (let source = 0; source < 3; source++) {
			let parentId: Id<"pages"> | undefined;
			for (let depth = 0; depth < 30; depth++) parentId = await ctx.db.insert("pages", {
				workspaceId, title: `Source ${source}/${depth}`, parentId,
				...(depth === 0 && { access: [{ role: memberRole, level: "view" as const }] }),
				archived: false, createdBy: owner.userId, updatedBy: owner.userId, updatedAt: Date.now(),
			});
			sources.push(parentId!);
		}
		return sources;
	});
	const target = await owner.mutation(api.messages.send, { chatId, text: "Team note", mentions: noMentions });
	const turnId = await agentTurn(t, owner, chatId, companybot._id);
	const turn = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!;
	await t.run((ctx) => ctx.db.patch(turn.replyId!, { usedPlaces: sources }));
	const call = (tool: string, request: object) => t.mutation(internal.manageTools.runFor, { turnId, tool, input: { request } });
	await t.run((ctx) => ctx.db.patch(turnId, { triggerId: target }));
	expect(await call("channels.manage", { action: "set_topic", chat: chatId, topic: "Updated from the sources" })).not.toHaveProperty("error");
	expect(await call("channels.manage", { action: "add_members", chat: chatId, userIds: [extra], agentIds: [] })).not.toHaveProperty("error");
	await t.mutation(internal.turns.finishReply, { turnId, decision: { emoji: "✅", new_point: "", to: "room", message: "" } });
	expect((await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.status).toBe("done");
	expect((await owner.query(api.chats.get, { chatId }))!.topic).toBe("Updated from the sources");
});
