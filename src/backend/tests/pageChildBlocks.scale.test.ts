import migrationsTest from "@convex-dev/migrations/test";
import prosemirrorSync from "@convex-dev/prosemirror-sync/test";
import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { readDoc } from "../convex/pageOps";
import schema from "../convex/schema";
import { addMember, modules, signIn, workspaceOf } from "./helpers";

afterEach(() => void vi.useRealTimers());

// COMPAT(0.1.0-alpha.10): delete with migrations.pageChildBlocks.
// Five pages a batch, each scanning the whole team for an owner, read 35,000 members: over Convex's 32,000.
it("backfills old sub-page blocks in a workspace of 7,000 whose only owner didn't make them, within limits", { timeout: 300_000 }, async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	migrationsTest.register(t);
	prosemirrorSync.register(t);
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const root = await owner.mutation(api.pages.create, { title: "Wiki" });
	const children: Id<"pages">[] = [];
	for (let i = 0; i < 12; i++) children.push(await owner.mutation(api.pages.create, { title: `Old ${i}`, parentId: root, insertInParent: false }));
	for (let start = 0; start < 7_000; start += 500)
		await t.run(async (ctx) => {
			for (let i = start; i < start + 500; i++) {
				const userId = await ctx.db.insert("users", { email: `person${i}@co.com` });
				await addMember(ctx, { workspaceId, userId, role: "member", email: `person${i}@co.com` });
			}
		});
	// Made and last edited by someone who has since left, so only the owner can add their blocks.
	await t.run(async (ctx) => {
		const gone = await ctx.db.insert("users", { email: "gone@co.com" });
		for (const id of [root, ...children]) await ctx.db.patch(id, { createdBy: gone, updatedBy: gone });
	});
	vi.useFakeTimers();
	try {
		await t.mutation(internal.migrations.runAll);
		await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
	} finally {
		vi.useRealTimers();
	}
	expect((await t.query(internal.migrations.status)).filter((m) => m.state !== "success")).toEqual([]);
	const blocks = await t.run(async (ctx) => (await readDoc(ctx, root)).firstChild!.content.content.flatMap((b) => b.firstChild?.type.name === "page" ? [b.firstChild.attrs.pageId as string] : []));
	expect(blocks.sort()).toEqual([...children].sort());
});
