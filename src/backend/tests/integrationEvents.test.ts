import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { generalOf, noMentions, ownerAndMember, setMemberSwitch } from "./helpers";
import type { Id } from "../convex/_generated/dataModel";

beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("CONNECTIONS_KEY", btoa("k".repeat(32))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function setup() {
	const { t, owner, member } = await ownerAndMember();
	await setMemberSwitch(owner, "integrations.manage", true);
	const scopes = ["workspace:read", "records:read", "records:write", "pages:read", "pages:write", "chats:read", "chats:write", "events:read"];
	const token = await member.mutation(api.integrationTokens.create, { name: "Sync app", scopes, days: 1 });
	const call = (operation: string, input = {}, secret = token.secret) => t.fetch("/api/v1/call", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation, input }) });
	return { t, owner, member, token, call, scopes };
}
describe("integration changes and request history", () => {
	it("delivers app changes with current scopes and place access, without private content", async () => {
		const { t, owner, member, token, call } = await setup();
		const type = (await owner.query(api.recordTypes.list))[0]!;
		const record = await owner.mutation(api.records.create, { typeId: type._id, values: { name: "Private business contents" } });
		const pageId = await owner.mutation(api.pages.create, { title: "A document" });
		const chat = await generalOf(owner);
		const messageId = await owner.mutation(api.messages.send, { chatId: chat._id, text: "Private message contents", mentions: noMentions });
		const feed = (await (await call("events_list")).json()).data;
		expect(feed.page.map((r: { resourceId: string }) => r.resourceId)).toEqual(expect.arrayContaining([record, pageId, messageId]));
		expect(JSON.stringify(feed)).not.toContain("contents");
		await t.run(ctx => ctx.db.patch(type._id, { access: [] }));
		await t.run(ctx => ctx.db.patch(pageId, { access: [] }));
		await t.run(ctx => ctx.db.patch(messageId, { usedPlaces: [type._id] }));
		expect((await (await call("events_list")).json()).data.page).toEqual([]);
		await t.run(ctx => ctx.db.patch(token.id, { scopes: ["events:read"] }));
		expect((await (await call("events_list")).json()).data.page).toEqual([]);
		await member.mutation(api.integrationTokens.revoke, { id: token.id });
		expect((await call("events_list")).status).toBe(401);
	});
	it("archives and restores resources, and confines message edits to the issuing connection", async () => {
		const { t, owner, member, token, call, scopes } = await setup();
		const type = (await owner.query(api.recordTypes.list))[0]!;
		const record = (await (await call("records_create", { typeId: type._id, values: { name: "Client" }, requestKey: "create-record-0001" })).json()).data;
		for (const archived of [true, false]) {
			expect((await call("records_archive", { recordId: record.id, archived, requestKey: `record-archive-${archived}-0001` })).status).toBe(200);
			expect((await t.run(ctx => ctx.db.get(record.id as Id<"records">)))?.archived).toBe(archived);
		}
		const page = (await (await call("pages_create", { title: "Before", requestKey: "create-page-000001" })).json()).data;
		expect((await call("pages_rename", { pageId: page.id, title: "After", requestKey: "rename-page-000001" })).status).toBe(200);
		for (const archived of [true, false]) expect((await call("pages_archive", { pageId: page.id, archived, requestKey: `page-archive-${archived}-0001` })).status).toBe(200);
		expect((await (await call("pages_get", { pageId: page.id })).json()).data.title).toBe("After");
		const chat = await generalOf(owner);
		const message = (await (await call("messages_post", { chatId: chat._id, text: "Before", requestKey: "post-message-00001" })).json()).data;
		expect((await call("messages_edit", { messageId: message.id, text: "After", requestKey: "edit-message-00001" })).status).toBe(200);
		expect((await (await call("messages_get", { messageId: message.id })).json()).data.text).toContain("After");
		const other = await member.mutation(api.integrationTokens.create, { name: "Sync app", scopes, days: 1 });
		expect((await call("messages_delete", { messageId: message.id, requestKey: "delete-message-0001" }, other.secret)).status).toBe(403);
		const human = await member.mutation(api.messages.send, { chatId: chat._id, text: "Human message", mentions: noMentions });
		expect((await call("messages_edit", { messageId: human, text: "Spoof", requestKey: "spoof-message-0001" })).status).toBe(403);
		expect((await call("messages_delete", { messageId: message.id, requestKey: "delete-message-0001" })).status).toBe(200);
		expect((await t.run(ctx => ctx.db.get(message.id as Id<"chatMessages">)))?.deleted).toBe(true);
		expect((await t.run(ctx => ctx.db.get(message.id as Id<"chatMessages">)))?.externalTokenId).toBe(token.id);
	});
	it("records successes, denials, validation errors and retries without logging content or secrets", async () => {
		const { t, owner, member, call, token } = await setup();
		const first = await call("workspace_get");
		expect(first.headers.get("X-Request-Id")).toBeTruthy();
		await call("pages_create", { title: "Do not put this in logs", requestKey: "request-key-secret-0001" });
		await call("pages_create", { title: "Do not put this in logs", requestKey: "request-key-secret-0001" });
		await call("pages_create", {});
		await call("records_get", { recordId: "not-an-id" });
		const rows = await member.query(api.integrationAudit.list, { cursor: null });
		expect(rows.page.map(r => r.status).sort()).toEqual([200, 200, 200, 400, 403]);
		const text = JSON.stringify(rows);
		for (const secret of [token.secret, "Do not put this in logs", "request-key-secret-0001", "not-an-id"]) expect(text).not.toContain(secret);
		expect((await owner.query(api.integrationAudit.list, { cursor: null })).page).toEqual([]);
		vi.advanceTimersByTime(31 * 86400000);
		await t.mutation(internal.integrationMaintenance.sweep, {});
		expect((await member.query(api.integrationAudit.list, { cursor: null })).page).toEqual([]);
	});
	it("counts refused operations against the request limit even when their writes roll back", async () => {
		const { t, token, call } = await setup();
		await t.run(ctx => ctx.db.patch(token.id, { windowAt: Date.now(), requests: 59 }));
		expect((await call("records_get", { recordId: "invalid" })).status).toBe(403);
		expect((await call("workspace_get")).status).toBe(429);
		vi.advanceTimersByTime(60001);
		expect((await call("workspace_get")).status).toBe(200);
	});
	it("queues stable signed-notification payloads, advances on success, retries five times, and stops on revoked access", async () => {
		const { t, owner, member, token, call } = await setup();
		await expect(member.action(api.integrationWebhooks.create, { tokenId: token.id, url: "http://127.0.0.1/webhook" })).rejects.toThrow();
		const webhook = await member.action(api.integrationWebhooks.create, { tokenId: token.id, url: "https://receiver.example/events" });
		const id = webhook.id as Id<"integrationWebhooks">;
		expect(JSON.stringify(await member.query(api.integrationWebhooks.list))).not.toContain(webhook.secret);
		expect(JSON.stringify(await t.run(ctx => ctx.db.get(id)))).not.toContain(webhook.secret);
		await owner.mutation(api.pages.create, { title: "First event" });
		const first = await t.mutation(internal.integrationWebhooks.prepare, { id });
		expect(first).not.toBeNull();
		expect(JSON.parse(first!.body)).toEqual({ id: first!.deliveryId, type: "events.available", createdAt: expect.any(Number) });
		await t.mutation(internal.integrationWebhooks.complete, { id, deliveryId: first!.deliveryId, status: 503 });
		const again = await t.mutation(internal.integrationWebhooks.prepare, { id });
		expect(again!.body).toBe(first!.body);
		await t.mutation(internal.integrationWebhooks.complete, { id, deliveryId: again!.deliveryId, status: 204 });
		expect(await t.mutation(internal.integrationWebhooks.prepare, { id })).toBeNull();
		vi.advanceTimersByTime(1000);
		await call("pages_create", { title: "Next", requestKey: "create-next-page-001" });
		const next = await t.mutation(internal.integrationWebhooks.prepare, { id });
		expect(next).not.toBeNull();
		expect(next!.deliveryId).not.toBe(first!.deliveryId);
		for (let attempt = 0; attempt < 5; attempt++) {
			const send = attempt === 0 ? next : await t.mutation(internal.integrationWebhooks.prepare, { id });
			await t.mutation(internal.integrationWebhooks.complete, { id, deliveryId: send!.deliveryId, status: 500 });
		}
		expect((await member.query(api.integrationWebhooks.list))[0]?.disabled).toBe(true);
		await member.mutation(api.integrationWebhooks.remove, { id });
		const active = await member.action(api.integrationWebhooks.create, { tokenId: token.id, url: "https://receiver.example/events" });
		await member.mutation(api.integrationTokens.revoke, { id: token.id });
		expect(await t.mutation(internal.integrationWebhooks.prepare, { id: active.id as Id<"integrationWebhooks"> })).toBeNull();
	});
});
