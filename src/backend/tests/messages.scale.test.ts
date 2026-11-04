import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MESSAGE_PAGE as PAGE_SIZE } from "@companybot/core";
import { agentsOf, generalOf, ownerAndMember, workspaceOf } from "./helpers";

// A busy channel: 10,000 messages people see, half of them agents' replies to someone else that used a
// private channel the reader isn't in, then 40,000 replies never shown (quiet) on top, the newest.
// Reading past the quiet ones would cross Convex's 32,000-document limit; the list's index skips them, so
// a page reads only the rows it returns (no `pageStatus`: Convex flags a page that read many more).
it("pages a 50,000-message channel, 40,000 quiet and 5,000 private to others, in full pages", { timeout: 600_000 }, async () => {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const chatId = (await generalOf(owner))._id;
	const { companybot } = await agentsOf(owner);
	const secret = await owner.mutation(api.chats.createChannel, { name: "secret", private: true });
	const base = { chatId, workspaceId, parts: [], mentions: { userIds: [], agentIds: [] }, status: "done" as const };
	const shown: Id<"chatMessages">[] = [];
	for (let start = 0; start < 50_000; start += 2_000) await t.run(async (ctx) => {
		for (let i = start; i < start + 2_000; i++) {
			if (i >= 10_000) await ctx.db.insert("chatMessages", { ...base, authorAgentId: companybot._id, text: `hidden ${i}`, quiet: true });
			else if (i % 2) shown.push(await ctx.db.insert("chatMessages", { ...base, authorAgentId: companybot._id, repliedTo: owner.userId, usedPlaces: [secret], text: `private ${i}` }));
			else shown.push(await ctx.db.insert("chatMessages", { ...base, authorUserId: owner.userId, text: `message ${i}` }));
		}
	});
	const page = (cursor: string | null) => member.query(api.messages.page, { chatId, paginationOpts: { numItems: PAGE_SIZE, cursor } });

	const first = await page(null);
	expect(first.page.map((m) => m._id)).toEqual(shown.slice(-PAGE_SIZE));
	expect(first.pageStatus ?? null).toBeNull();
	// Replies to someone else are in the page, masked, so it's never short.
	const masked = first.page.filter((m) => m.privacy?.hidden);
	expect(masked).toHaveLength(PAGE_SIZE / 2);
	expect(masked.every((m) => m.text.startsWith("🔒") && !/private \d/.test(m.text))).toBe(true);

	const older = await page(first.continueCursor);
	expect(older.page.map((m) => m._id)).toEqual(shown.slice(-2 * PAGE_SIZE, -PAGE_SIZE));
	expect(older.pageStatus ?? null).toBeNull();
	expect(older.page.filter((m) => m.privacy?.hidden)).toHaveLength(PAGE_SIZE / 2);
	expect(older.isDone).toBe(false);
});
