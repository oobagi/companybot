import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { addMember, newTest, settle, signIn, workspaceOf } from "./helpers";

it("scrubs a deleted role from 35k restricted pages and members under transaction limits", { timeout: 600_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const workspaceId = await workspaceOf(owner);
	const role = await owner.mutation(api.roles.create, { name: "Restricted" });
	const page = { workspaceId, title: "Restricted", archived: false, createdBy: owner.userId, updatedBy: owner.userId, updatedAt: 0, access: [{ role, level: "edit" as const }] };
	for (let start = 0; start < 35_000; start += 1_000) {
		await t.run(async (ctx) => {
			for (let i = start; i < start + 1_000; i++) {
				await ctx.db.insert("pages", page);
				if (i < 1_000) {
					const userId = await ctx.db.insert("users", { email: `person${i}@co.com` });
					const id = await addMember(ctx, { workspaceId, userId, role: "member" });
					await ctx.db.patch(id, { roles: [role] });
				}
			}
		});
	}
	await owner.mutation(api.roles.remove, { id: role });
	expect(await t.run((ctx) => ctx.db.get(role))).toBeNull();
	await settle(t);
	let count = 0;
	let cursor: string | null = null;
	for (;;) {
		const result = await t.run((ctx) => ctx.db.query("pages").paginate({ cursor, numItems: 1000 }));
		for (const row of result.page) { expect(row.access).toEqual([]); count++; }
		if (result.isDone) break;
		cursor = result.continueCursor;
	}
	expect(count).toBe(35_000);
	expect(await t.run(async (ctx) => (await ctx.db.query("members").collect()).filter((m) => m.userId !== owner.userId).every((m) => m.roles?.length === 0))).toBe(true);
	expect(await t.run((ctx) => ctx.db.query("cascades").first())).toBeNull();
});
