import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { integrationEvent } from "../convex/integrationEventLog";
import { ownerAndMember, setMemberSwitch, workspaceOf } from "./helpers";

afterEach(() => vi.useRealTimers());
it("drains a large permission-filtered event feed, resumes after idle, and sweeps retention in bounded batches", async () => {
	vi.useFakeTimers();
	const { t, owner, member } = await ownerAndMember();
	await setMemberSwitch(owner, "integrations.manage", true);
	const token = await member.mutation(api.integrationTokens.create, { name: "Sync", scopes: ["events:read", "pages:read"], days: 30 });
	const visible = await owner.mutation(api.pages.create, { title: "Visible" });
	const hidden = await owner.mutation(api.pages.create, { title: "Hidden" });
	const workspaceId = await workspaceOf(owner);
	await t.run(async ctx => {
		await ctx.db.patch(hidden, { access: [] });
		for (let i = 0; i < 1000; i++) await integrationEvent(ctx, workspaceId, "page.updated", i % 2 ? visible : hidden);
	});
	const read = async (cursor: string | null) => {
		const response = await t.fetch("/api/v1/call", { method: "POST", headers: { Authorization: `Bearer ${token.secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "events_list", input: { cursor, limit: 50 } }) });
		expect(response.status).toBe(200);
		return (await response.json()).data as { page: { id: string; resourceId: string }[]; continueCursor: string; isDone: boolean };
	};
	let cursor: string | null = null;
	const found = new Set<string>();
	for (let n = 0; n < 25; n++) {
		const batch = await read(cursor);
		for (const event of batch.page) { expect(event.resourceId).toBe(visible); expect(found.has(event.id)).toBe(false); found.add(event.id); }
		cursor = batch.continueCursor;
		if (batch.isDone) break;
	}
	expect(found.size).toBe(501);
	expect((await read(cursor)).page).toEqual([]);
	vi.advanceTimersByTime(61000);
	await t.run(ctx => integrationEvent(ctx, workspaceId, "page.updated", visible));
	expect((await read(cursor)).page).toHaveLength(1);
	vi.advanceTimersByTime(8 * 86400000);
	await t.mutation(internal.integrationMaintenance.sweep, {});
	await t.finishAllScheduledFunctions(vi.runAllTimers);
	expect(await t.run(ctx => ctx.db.query("integrationEvents").first())).toBeNull();
	expect((await read(null)).page).toEqual([]);
});
