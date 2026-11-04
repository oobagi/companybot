import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { generalOf, ownerAndMember, workspaceOf } from "./helpers";

// A command reads only the id it names, and `get` returns stored ids without reading each one,
// so a 2,000-channel order stays under Convex's per-transaction limits for both.
it("saves and loads a 2,000-channel order without exceeding transaction limits", { timeout: 600_000 }, async () => {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const general = await generalOf(owner);
	const ids: Id<"chats">[] = [];
	for (let start = 0; start < 2_000; start += 200) await t.run(async (ctx) => {
		for (let i = start; i < start + 200; i++) ids.push(await ctx.db.insert("chats", { workspaceId, kind: "channel", name: `c${i}`, private: i % 2 === 0, archived: false, createdBy: owner.userId, lastMessageAt: 0 }));
	});
	// The first drag of a never-saved list fills it with every channel shown before the drop.
	await owner.mutation(api.arrangements.change, { list: "channels", command: { op: "move", id: general._id, beforeId: null, fill: ids } });
	await member.mutation(api.arrangements.change, { list: "channels", command: { op: "move", id: ids[1_999]!, beforeId: ids[0]! } });
	await owner.mutation(api.arrangements.change, { list: "pins", command: { op: "add", id: `chat:${ids[5]}` } });
	const rows = (await member.query(api.arrangements.get))!.rows;
	const order = rows.find((r) => r.list === "channels")!.ids;
	expect(order).toHaveLength(2_001);
	expect(order.slice(0, 2)).toEqual([ids[1_999], ids[0]]);
	expect(order.at(-1)).toBe(general._id);
});
