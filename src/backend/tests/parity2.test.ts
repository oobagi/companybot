import { afterEach, expect, it, vi } from "vitest";
import { type ManageTool, pickAgentConfig } from "@companybot/core";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { IDLE_MS, readDoc } from "../convex/pageOps";
import { agentTurn, agentsOf, generalOf, noMentions, setup, sideWorkspace, turnsOf, workspaceOf } from "./helpers";

afterEach(() => vi.useRealTimers());

async function ready() {
	const { t, owner, member } = await setup();
	const { companybot, scribe } = await agentsOf(owner);
	const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const mdm = await member.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const turnId = await agentTurn(t, owner, dm, companybot._id);
	const memberTurn = await agentTurn(t, member, mdm, companybot._id);
	const call = (tool: ManageTool, request: unknown, asMember = false): Promise<any> =>
		t.mutation(internal.manageTools.runFor, { turnId: asMember ? memberTurn : turnId, tool, input: { request } });
	const field = (input: object, asMember = false): Promise<any> => t.mutation(internal.recordTools.saveFieldFor, { turnId: asMember ? memberTurn : turnId, input });
	return { t, owner, member, companybot, scribe, turnId, memberTurn, call, field, dm };
}

it("renames options by stable id, reorders options/fields, retires and revives options without rewriting records", async () => {
	const { t, owner, turnId, field } = await ready();
	const clients = (await owner.query(api.recordTypes.list)).find((t) => t.key === "client")!;
	const record = await owner.mutation(api.records.create, { typeId: clients._id, values: { name: "Acme", status: "Lead" } });
	const schema = await t.query(internal.recordTools.typesFor, { turnId });
	const status = schema.types.find((t) => t.type === "client")!.fields.find((f) => f.key === "status")!;
	const [lead, ...rest] = status.choices!;
	const options = [...rest, { id: lead!.id, label: "Prospect" }];
	expect(await field({ type: "client", field: "status", options })).toMatchObject({ choices: options });
	expect((await owner.query(api.records.get, { recordId: record }))!.values.status).toBe(lead!.id);
	expect(await t.query(internal.recordTools.getFor, { turnId, id: record })).toMatchObject({ values: { status: "Prospect" } });
	await field({ type: "client", field: "status", options: rest });
	expect((await field({ type: "client", field: "status", options })).choices.at(-1)).toEqual({ id: lead!.id, label: "Prospect" });
	expect(await field({ type: "client", field: "status", position: 2 })).toHaveProperty("position", 2);
	expect((await t.query(internal.recordTools.typesFor, { turnId })).types.find((t) => t.type === "client")!.fields[2]!.key).toBe("status");
	const last = (await owner.query(api.records.activity, { paginationOpts: { cursor: null, numItems: 1 } })).page[0]!;
	expect(last).toMatchObject({ agent: "Companybot", changes: [expect.objectContaining({ key: "position", new: 2 })] });
});

it("enforces maker/owner field gates, Trash ownership and database discovery/restore", async () => {
	const { t, owner, member, field, turnId } = await ready();
	for (const update of [{ options: [{ id: "lead", label: "Prospect" }] }, { position: 1 }, { trash: true }])
		expect(await field({ type: "client", field: "status", ...update }, true)).toHaveProperty("error");
	expect(await field({ type: "client", field: "name", position: 1 })).toHaveProperty("error");
	const made = await field({ type: "client", label: "Roof", kind: "choice", options: ["Metal", "Tile"] }, true);
	expect(await field({ type: "client", field: made.key, position: 1 }, true)).toHaveProperty("error");
	await field({ type: "client", field: made.key, trash: true }, true);
	expect((await t.query(internal.recordTools.typesFor, { turnId })).types.find((t) => t.type === "client")!.fields.find((f) => f.key === made.key)).toHaveProperty("inTrash", true);
	expect(await field({ type: "client", field: made.key, trash: false }, true)).not.toHaveProperty("error");
	const other = await owner.mutation(api.fields.create, { typeId: (await member.query(api.recordTypes.list))[0]!._id, label: "Owner field", kind: "text" });
	await owner.mutation(api.fields.archive, { fieldId: other._id });
	expect(await field({ type: "client", field: other.key, trash: false }, true)).toHaveProperty("error");
	const database = await owner.mutation(api.recordTypes.create, { plural: "Projects" });
	await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { type: database, trash: true } });
	expect((await t.query(internal.recordTools.typesFor, { turnId, trashed: true })).types).toEqual(expect.arrayContaining([expect.objectContaining({ type: "project", inTrash: true })]));
	expect(await t.mutation(internal.recordTools.saveDatabaseFor, { turnId, input: { type: database, trash: false } })).not.toHaveProperty("error");
});

it("pages full record history and workspace Activity, with undo and cross-workspace denial", async () => {
	const { t, owner, turnId, memberTurn } = await ready();
	const typeId = (await owner.query(api.recordTypes.list))[0]!._id;
	const id = await owner.mutation(api.records.create, { typeId, values: { name: "v0" } });
	for (let i = 1; i <= 24; i++) await owner.mutation(api.records.update, { recordId: id, values: { name: `v${i}` } });
	const first: any = await t.query(internal.recordTools.historyFor, { turnId, id });
	expect(first.page).toHaveLength(20);
	expect(first.isDone).toBe(false);
	const rest: any = await t.query(internal.recordTools.historyFor, { turnId, id, cursor: first.continueCursor });
	expect(rest.isDone).toBe(true);
	expect(new Set([...first.page, ...rest.page].map((e: any) => e._id)).size).toBe(25);
	expect(await t.query(internal.recordTools.historyFor, { turnId })).toEqual(await owner.query(api.records.activity, { paginationOpts: { cursor: null, numItems: 20 } }));
	expect(await t.mutation(internal.recordTools.undoFor, { turnId: memberTurn, change: first.page[0]._id })).toMatchObject({ values: { name: "v23" } });
	expect(await t.mutation(internal.recordTools.undoFor, { turnId, change: first.page[0]._id })).toHaveProperty("error");
	const side = await sideWorkspace(t, "owner@co.com");
	const foreignType = await owner.in(side.workspaceId).mutation(api.recordTypes.create, { plural: "Secrets" });
	const foreign = await owner.in(side.workspaceId).mutation(api.records.create, { typeId: foreignType, values: { name: "secret" } });
	expect(await t.query(internal.recordTools.historyFor, { turnId, id: foreign })).toHaveProperty("error");
});

it("Activity keeps invisible chats and other people's private outputs out", async () => {
	const { t, owner, turnId, memberTurn } = await ready();
	await t.mutation(internal.activity.log, { turnId, callId: "private", tool: "records.get", changes: false, input: "{}", output: "PRIVATE" });
	expect((await t.query(internal.recordTools.historyFor, { turnId: memberTurn, source: "agents" }) as any).page).toEqual([]);
	const general = await generalOf(owner);
	await t.run(async (ctx) => {
		const row = (await ctx.db.query("agentActivity").collect())[0]!;
		await ctx.db.patch(row._id, { chatId: general._id });
	});
	const feed: any = await t.query(internal.recordTools.historyFor, { turnId: memberTurn, source: "agents" });
	expect(feed.page).toHaveLength(1);
	expect(feed.page[0].output).toBeUndefined();
	expect((await t.query(internal.recordTools.historyFor, { turnId, source: "agents" }) as any).page[0].output).toBe("PRIVATE");
});

it("pages all retained versions, previews/restores one, preserves rich block properties and denies foreign versions", async () => {
	const { t, owner, turnId } = await ready();
	const page = await owner.mutation(api.pages.create, { title: "Styled SOP" });
	const blocks = [{ type: "blockContainer", attrs: { id: "stable-block" }, content: [{ type: "paragraph", attrs: { textAlignment: "center", backgroundColor: "blue", textColor: "red" }, content: [{ type: "text", text: "Hello", marks: [{ type: "bold" }] }] }] }];
	const write = (input: object) => t.mutation(internal.pageTools.writeFor, { turnId, input: { page, ...input } }) as Promise<any>;
	for (let i = 0; i < 23; i++) {
		vi.advanceTimersByTime(IDLE_MS + 1);
		expect(await write({ blocks: JSON.stringify(blocks), mode: "append" })).not.toHaveProperty("error");
	}
	const history: any = await t.query(internal.pageTools.readFor, { turnId, page, history: true });
	expect(history.versions).toHaveLength(20);
	expect(history.moreVersions).toBe(true);
	const rest: any = await t.query(internal.pageTools.readFor, { turnId, page, history: true, cursor: history.cursor });
	expect(rest.versions).toHaveLength(3);
	expect(rest.moreVersions).toBe(false);
	const oldest = rest.versions.at(-1).version;
	const preview: any = await t.query(internal.pageTools.readFor, { turnId, version: oldest });
	expect(JSON.parse(preview.doc).content[0].content[0]).toMatchObject(blocks[0]!);
	expect(await write({ restore: oldest })).toHaveProperty("restored", oldest);
	const before = await t.run(async (ctx) => (await readDoc(ctx, page)).toJSON());
	expect(await write({ blocks: JSON.stringify(before.content[0].content), mode: "replace" })).toHaveProperty("unchanged", true);
	expect(await t.run(async (ctx) => (await readDoc(ctx, page)).toJSON())).toEqual(before);
	const side = await sideWorkspace(t, "owner@co.com");
	const foreign = await owner.in(side.workspaceId).mutation(api.pages.create, { title: "Foreign" });
	expect(await t.query(internal.pageTools.readFor, { turnId, page: foreign, version: oldest })).toHaveProperty("error");
	expect(await write({ markdown: "x", blocks: "[]" })).toHaveProperty("error");
	await write({ trash: true });
	expect((await t.query(internal.pageTools.findFor, { turnId, input: { trashed: true } })).rows).toContainEqual(expect.objectContaining({ id: page }));
	expect(await write({ restore: oldest })).toHaveProperty("error");
	await write({ trash: false });
	expect(await write({ restore: oldest })).not.toHaveProperty("error");
});

it("manages safe agent config with version/owner checks and never expands tools or self-modifies", async () => {
	const { t, call, companybot, scribe, owner } = await ready();
	const created = await call("agents.manage", { action: "create" });
	const id = created.id as Id<"agents">;
	expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ tools: [] });
	expect((await call("agents.manage", { action: "list" })).page).toContainEqual(expect.objectContaining({ id }));
	expect(await call("agents.manage", { action: "get", id })).toMatchObject({ version: 1, tools: [], models: expect.any(Array) });
	expect(await call("agents.manage", { action: "history", id })).toMatchObject({ page: [expect.objectContaining({ version: 1 })] });
	await call("agents.manage", { action: "update", id, expectedVersion: 1, name: "Research", description: "Researches", instructions: "Research", model: scribe.model });
	expect(await call("agents.manage", { action: "update", id, expectedVersion: 1, name: "Stale" })).toHaveProperty("error");
	for (const field of ["instructions", "model"])
		expect(await call("agents.manage", { action: "update", id: companybot._id, expectedVersion: companybot.version, [field]: companybot[field as "model" | "instructions"] })).toHaveProperty("error");
	expect(await call("agents.manage", { action: "update", id: companybot._id, expectedVersion: companybot.version, name: "Companybot 2" })).not.toHaveProperty("error");
	for (const request of [{ action: "create" }, { action: "archive", id }, { action: "update", id, expectedVersion: 2, name: "No" }])
		expect(await call("agents.manage", request, true)).toHaveProperty("error");
	await call("agents.manage", { action: "archive", id });
	expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ archived: true, tools: [] });
	const side = await sideWorkspace(t, "owner@co.com");
	const foreign = await owner.in(side.workspaceId).mutation(api.agents.create);
	expect(await call("agents.manage", { action: "get", id: foreign })).toHaveProperty("error");
});

it("updates only the acting person's preferences, validates zones and refuses device measurement fields", async () => {
	const { call, member, owner } = await ready();
	expect(await call("workspace.settings", { action: "get_preferences" }, true)).toMatchObject({ timeZone: null });
	expect(await call("workspace.settings", { action: "update_preferences", displayName: "Dana", notify: "mentions", sendWith: "mod-enter", timeZone: "America/Los_Angeles" }, true)).toMatchObject({ updated: true });
	expect(await member.query(api.preferences.get)).toMatchObject({ displayName: "Dana", timeZone: "America/Los_Angeles" });
	expect(await owner.query(api.preferences.get)).toMatchObject({ displayName: "" });
	expect(await call("workspace.settings", { action: "update_preferences", timeZone: "invalid" }, true)).toHaveProperty("error");
	await call("workspace.settings", { action: "update_preferences", timeZone: null }, true);
	expect(await member.query(api.preferences.get)).toMatchObject({ timeZone: null });
});

it("edits/deletes only own visible messages, reacts to chosen messages and marks read explicitly", async () => {
	const { call, owner, member, companybot } = await ready();
	const chatId = (await generalOf(owner))._id;
	const mine = await owner.mutation(api.messages.send, { chatId, text: "Original", mentions: noMentions });
	const theirs = await member.mutation(api.messages.send, { chatId, text: "Member", mentions: noMentions });
	expect(await call("chat.manage", { action: "edit", messageId: mine, text: "Edited" })).toHaveProperty("done", "edit");
	for (const action of ["edit", "delete"])
		expect(await call("chat.manage", { action, messageId: theirs, ...(action === "edit" && { text: "No" }) })).toHaveProperty("error");
	await call("chat.manage", { action: "react", messageId: theirs, emoji: "✅" });
	expect((await owner.query(api.messages.list, { chatId })).find((m) => m._id === theirs)!.reactions[0]!.names).toContain(companybot.name);
	expect(await call("chat.manage", { action: "mark_read", chat: chatId })).toHaveProperty("done", "mark_read");
	const { messageId } = await call("chat.manage", { action: "send", chat: chatId, text: "Agent delivery" });
	expect(await call("chat.manage", { action: "edit", messageId, text: "Corrected" })).toHaveProperty("done", "edit");
	await call("chat.manage", { action: "delete", messageId: mine });
	expect((await owner.query(api.messages.list, { chatId })).find((m) => m._id === mine)).toHaveProperty("deleted", true);
	const privateId = await owner.mutation(api.chats.createChannel, { name: "secret", private: true });
	const secret = await owner.mutation(api.messages.send, { chatId: privateId, text: "Secret", mentions: noMentions });
	for (const request of [{ action: "react", messageId: secret, emoji: "✅" }, { action: "mark_read", chat: privateId }])
		expect(await call("chat.manage", request, true)).toHaveProperty("error");
});

it("installs library automations only as owners and sample-runs with the same edit/dispatch rules", async () => {
	const { t, call, scribe, owner, member } = await ready();
	const library = (await call("automations.manage", { action: "list" })).library;
	const id = library[0].id;
	expect(await call("automations.manage", { action: "install", id, timeZone: "UTC" }, true)).toHaveProperty("error");
	// This catalog entry has no required connectors.
	const free = library.find((x: { id: string }) => x.id === "morning-brief")?.id ?? id;
	expect(await call("automations.manage", { action: "install", id: free, timeZone: "UTC" })).toMatchObject({ installed: free });
	const custom = await member.mutation(api.automations.create, { config: { name: "Review", prompt: "Review", trigger: { type: "event", event: "member.joined" } }, agentId: scribe._id, audience: "subscribers", timeZone: "UTC" });
	await t.run((ctx) => ctx.db.patch(scribe._id, { tools: ["automations.manage"] }));
	const before = await turnsOf(t);
	expect(await call("automations.manage", { action: "run", id: custom })).toMatchObject({ done: "run" });
	const run = (await turnsOf(t)).find((r) => !before.some((b) => b._id === r._id))!;
	const install = await t.run((ctx) => ctx.db.query("automationInstalls").withIndex("by_workspace", (q) => q.eq("workspaceId", run.workspaceId).eq("automationId", custom)).first());
	await t.run((ctx) => ctx.db.patch(install!._id, { custom: { ...install!.custom!, updatedBy: owner.userId } }));
	expect(await t.mutation(internal.manageTools.runFor, { turnId: run._id, tool: "automations.manage", input: { request: { action: "run", id: custom } } })).toMatchObject({ error: expect.stringContaining("cannot start another run") });
});

it("targets another agent's memories while preserving personal privacy, team rights and the off switch", async () => {
	const { t, owner, member, scribe, turnId, memberTurn } = await ready();
	const mine = await t.mutation(internal.memory.createFor, { turnId, agentId: scribe._id, scope: "personal", content: "Private preference" });
	expect((await t.query(internal.memory.searchFor, { turnId, agentId: scribe._id, query: "" })).map((m) => m.id)).toEqual([mine.id]);
	await t.mutation(internal.memory.updateFor, { turnId, id: mine.id as Id<"memories">, content: "Corrected" });
	await expect(t.mutation(internal.memory.removeFor, { turnId: memberTurn, id: mine.id as Id<"memories"> })).rejects.toThrow("not found");
	const team = await t.mutation(internal.memory.createFor, { turnId, agentId: scribe._id, scope: "workspace", content: "Shared" });
	await expect(t.mutation(internal.memory.updateFor, { turnId: memberTurn, id: team.id as Id<"memories">, content: "No" })).rejects.toThrow("can't change");
	await expect(t.mutation(internal.memory.createFor, { turnId: memberTurn, agentId: scribe._id, scope: "workspace", content: "No" })).rejects.toThrow("permission");
	await t.mutation(internal.memory.removeFor, { turnId, id: mine.id as Id<"memories"> });
	const generalTurn = await agentTurn(t, member, (await generalOf(member))._id, scribe._id);
	await expect(t.mutation(internal.memory.createFor, { turnId: generalTurn, agentId: scribe._id, scope: "personal", content: "No" })).rejects.toThrow("2+ people");
	const side = await sideWorkspace(t, "owner@co.com");
	const foreign = await owner.in(side.workspaceId).mutation(api.agents.create);
	await expect(t.query(internal.memory.searchFor, { turnId, agentId: foreign, query: "" })).rejects.toThrow("not found");
	const settings = (await owner.query(api.workspace.settings))!;
	await owner.mutation(api.workspace.updateSettings, { name: settings.name, expectedVersion: settings.version, memory: false });
	await expect(t.query(internal.memory.searchFor, { turnId, agentId: scribe._id, query: "" })).rejects.toThrow("turned memory off");
});
