import { approxTokens, canonicalJson, systemPrompt } from "@companybot/core";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { createField, createRecord, createType, updateField, updateRecord, updateType } from "../convex/recordOps";
import { createPage, renamePage, writeBlocks } from "../convex/pageOps";
import { saveView } from "../convex/databaseViews";
import { type Who, memberOf } from "../convex/lib";
import { readArtifact, turnSources, writeSources } from "../convex/replySources";
import { canReadReply } from "../convex/replyPrivacy";
import { KEEP_TOKENS, runningTurn } from "../convex/turns";
import { createWakeup, wake } from "../convex/wakeups";
import "./connectorFixtures";
import { agentsOf, agentTurn, generalOf, identityOf, noMentions, ownerAndMember, signIn, turnsOf, type As, setMemberSwitch, settle } from "./helpers";

async function decideReaction(t: Awaited<ReturnType<typeof ownerAndMember>>["t"], turnId: Id<"agentTurns">, triggerId: Id<"chatMessages">, emoji: string) {
	await t.run((ctx) => ctx.db.patch(turnId, { triggerId }));
	await t.mutation(internal.turns.finishReply, { turnId, decision: { emoji, new_point: "", to: "room", message: "" } });
	return (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!;
}

const SECRET = "Quartz contract: $91,000, margin 42%";
beforeEach(() => void vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function setup() {
	const { t, owner, member: crew } = await ownerAndMember();
	await owner.mutation(api.workspace.invite, { email: "dana@co.com", role: "member" });
	const dana = await signIn(t, "dana@co.com");
	await dana.mutation(api.preferences.update, { displayName: "Dana" });
	const office = await owner.mutation(api.roles.create, { name: "Office" });
	const team = (await owner.query(api.workspace.team))!.members;
	await owner.mutation(api.workspace.setRoles, { id: team.find((m) => m.userId === dana.userId)!.id, roles: [office] });
	const deals = (await owner.query(api.recordTypes.list)).find((d) => d.key === "deal")!._id;
	const deal = await owner.mutation(api.records.create, { typeId: deals, values: { name: SECRET } });
	await owner.mutation(api.recordTypes.setAccess, { typeId: deals, access: [{ role: office, level: "view" }] });
	const chat = await generalOf(owner);
	const { companybot } = await agentsOf(owner);
	const start = (as: As, chatId = chat._id) => agentTurn(t, as, chatId, companybot._id);
	const turnId = await start(dana);
	const turn = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!;
	const replyId = turn.replyId!;
	const read = () => t.mutation(internal.recordTools.getFor, { turnId, id: deal });
	const write = (text = SECRET) => t.mutation(internal.turns.updateReply, { turnId, text, parts: [{ type: "text", text }] });
	const finish = async (text = SECRET) => { await write(text); await t.mutation(internal.turns.finishReply, { turnId }); };
	const reply = async (as: As) => (await as.query(api.messages.list, { chatId: chat._id })).find((m) => m._id === replyId)!;
	return { t, owner, crew, dana, office, deals, deal, chat, companybot, start, turnId, replyId, read, write, finish, reply, turn };
}

async function connectorSetup() {
	const s = await setup();
	await s.owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
	await s.owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "fixture-key" } });
	await s.owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [s.office] });
	const install = (await s.t.run((ctx) => ctx.db.query("connectorInstalls").first()))!;
	const readConnector = () => s.t.mutation(internal.connectors.forCall, { turnId: s.turnId, connectorId: "crm" });
	return { ...s, install, readConnector };
}

describe("workspace connector sources", () => {
	it("keeps Office connector reads private in general and refuses team memory", async () => {
		const s = await connectorSetup();
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
		expect(await s.readConnector()).not.toBeNull();
		expect((await s.t.run((ctx) => ctx.db.get(s.replyId)))!.usedPlaces).toContain(s.install._id);
		await s.write();
		expect((await s.reply(s.dana)).privacy).toMatchObject({ hidden: false, label: "Only Office and Owners can see this" });
		expect((await s.reply(s.dana)).privacy!.why).toContain("CRM connector");
		expect(JSON.stringify(await s.reply(s.crew))).not.toContain(SECRET);
		expect(JSON.stringify(await s.crew.query(api.messages.stream, { messageId: s.replyId }))).not.toContain(SECRET);
		await expect(s.t.mutation(internal.memory.createFor, { turnId: s.turnId, scope: "workspace", content: SECRET })).rejects.toThrow("Only Office and Owners");
		expect(JSON.stringify(await s.crew.query(api.memory.list))).not.toContain(SECRET);
	});

	it("lets everyone with connector access read the answer and saves to a matching audience", async () => {
		const { t, owner, member } = await ownerAndMember();
		const chat = await generalOf(owner);
		const { companybot } = await agentsOf(owner);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		await owner.action(api.connectors.connect, { connectorId: "crm", credentials: { type: "api_key", key: "fixture-key" } });
		const turnId = await agentTurn(t, member, chat._id, companybot._id);
		expect(await t.mutation(internal.connectors.forCall, { turnId, connectorId: "crm" })).not.toBeNull();
		await t.mutation(internal.turns.updateReply, { turnId, text: SECRET, parts: [{ type: "text", text: SECRET }] });
		const replyId = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		for (const viewer of [owner, member]) {
			const reply = (await viewer.query(api.messages.list, { chatId: chat._id })).find((m) => m._id === replyId)!;
			expect((await viewer.query(api.messages.stream, { messageId: replyId }))!.text).toBe(SECRET);
			expect(reply.privacy?.hidden).not.toBe(true);
			expect(reply.privacy!.share).toContain("Member");
			expect(reply.privacy!.share).toContain("Owners");
			expect(reply.privacy!.share).toContain("CRM connector");
		}
		const memberRole = (await owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!.id;
		const page = await owner.mutation(api.pages.create, { title: "CRM notes" });
		await owner.mutation(api.pages.setAccess, { pageId: page, access: [{ role: memberRole, level: "edit" }] });
		const result = await t.mutation(internal.pageTools.writeFor, { turnId, input: { page, title: SECRET } });
		expect(result).not.toHaveProperty("error");
		expect((await member.query(api.pages.get, { pageId: page }))!.title).toBe(SECRET);
	});

	it("does not treat default Member access as access for custom-role-only channel readers", async () => {
		const s = await connectorSetup();
		await s.finish("Done.");
		const memberRole = (await s.owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!.id;
		await s.owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [memberRole] });
		const turnId = await s.start(s.crew);
		expect(await s.t.mutation(internal.connectors.forCall, { turnId, connectorId: "crm" })).not.toBeNull();
		await s.t.mutation(internal.turns.updateReply, { turnId, text: SECRET, parts: [{ type: "text", text: SECRET }] });
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		const reply = async (viewer: As) => (await viewer.query(api.messages.list, { chatId: s.chat._id })).find((m) => m._id === replyId)!;
		expect((await s.crew.query(api.messages.stream, { messageId: replyId }))!.text).toBe(SECRET);
		expect((await reply(s.dana)).privacy?.hidden).toBe(true);
		expect(JSON.stringify(await reply(s.dana))).not.toContain(SECRET);
		await expect(s.t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: SECRET })).rejects.toThrow("wider audience");
	});

	it("uses changed install roles for old replies and subsequent writes", async () => {
		const s = await connectorSetup();
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "pages.edit", on: true });
		const page = await s.owner.mutation(api.pages.create, { title: "Office notes" });
		await s.owner.mutation(api.pages.setAccess, { pageId: page, access: [{ role: s.office, level: "edit" }] });
		await s.readConnector(); await s.write();
		const save = () => s.t.mutation(internal.pageTools.writeFor, { turnId: s.turnId, input: { page, title: SECRET } });
		const memberRole = (await s.owner.query(api.roles.list))!.find((r) => r.builtIn === "member")!.id;
		await s.owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [memberRole] });
		expect((await s.reply(s.dana)).privacy?.hidden).toBe(true);
		expect((await s.crew.query(api.messages.stream, { messageId: s.replyId }))!.text).toBe(SECRET);
		expect(await save()).toHaveProperty("error", expect.stringContaining("wider audience"));
		expect(await s.readConnector()).toBeNull();
		await s.owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles: [memberRole, s.office] });
		expect((await s.dana.query(api.messages.stream, { messageId: s.replyId }))!.text).toBe(SECRET);
		expect(await save()).not.toHaveProperty("error");
	});

	it("keeps a deleted install's replies Owners-only and lets an Owner explicitly share the answer", async () => {
		const s = await connectorSetup();
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
		await s.readConnector(); await s.write();
		await s.owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: false });
		for (const viewer of [s.dana, s.crew]) {
			expect((await s.reply(viewer)).privacy?.hidden).toBe(true);
			expect(JSON.stringify(await viewer.query(api.messages.stream, { messageId: s.replyId }))).not.toContain(SECRET);
		}
		expect((await s.reply(s.owner)).privacy?.hidden).toBe(false);
		expect((await s.owner.query(api.messages.stream, { messageId: s.replyId }))!.text).toBe(SECRET);
		expect((await s.t.run((ctx) => ctx.db.get(s.replyId)))!.usedPlaces).toContain(s.install._id);
		await expect(s.t.mutation(internal.memory.createFor, { turnId: s.turnId, scope: "workspace", content: SECRET })).rejects.toThrow("wider audience");
		await s.finish();
		await s.owner.mutation(api.messages.share, { messageId: s.replyId });
		expect((await s.reply(s.crew)).text).toBe(SECRET);
	});

	it("lets Owners list and edit connector-derived Deals after uninstall and reinstall", async () => {
		const s = await connectorSetup();
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "records.edit", on: true });
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: s.deals, access: [{ role: s.office, level: "edit" }] });
		await s.readConnector();
		expect(await s.t.mutation(internal.recordTools.saveFor, { turnId: s.turnId, input: { id: s.deal, values: { name: "CRM deal" } } })).not.toHaveProperty("error");
		expect((await s.t.run((ctx) => ctx.db.get("recordTypes", s.deals)))!.usedPlaces).toContain(s.install._id);
		await s.finish(); await cancelScheduled(s.t);
		await s.owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: false });
		await settle(s.t);
		const check = async () => {
			expect((await s.owner.query(api.recordTypes.list)).some((type) => type._id === s.deals)).toBe(true);
			for (const viewer of [s.dana, s.crew]) expect((await viewer.query(api.recordTypes.list)).some((type) => type._id === s.deals)).toBe(false);
			await s.owner.mutation(api.records.update, { recordId: s.deal, values: { name: `Owner edit ${Date.now()}` } });
			const turnId = await s.start(s.owner);
			expect(await s.t.mutation(internal.recordTools.saveFor, { turnId, input: { id: s.deal, values: { name: `Agent edit ${Date.now()}` } } })).not.toHaveProperty("error");
			await s.t.mutation(internal.turns.finishReply, { turnId });
			await cancelScheduled(s.t);
		};
		await check();
		// Drain the uninstall before reinstalling; no model jobs are left to run.
		await settle(s.t);
		await s.owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: true });
		const roles = (await s.owner.query(api.roles.list))!.filter((r) => r.builtIn !== "owner").map((r) => r.id);
		await s.owner.mutation(api.connectors.setRoles, { connectorId: "crm", roles });
		await check();
		expect((await s.t.run((ctx) => ctx.db.get("recordTypes", s.deals)))!.usedPlaces).toContain(s.install._id);
	});

	it("keeps connector-derived channels usable by Owners after uninstall while excluding other roles", async () => {
		const s = await connectorSetup();
		await s.finish();
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "channels.edit", on: true });
		const room = await s.owner.mutation(api.chats.createChannel, { name: "crm-work", private: false });
		await s.owner.mutation(api.chats.setAccess, { chatId: room, access: [{ role: s.office, level: "edit" }] });
		const turnId = await s.start(s.dana, room);
		expect(await s.t.mutation(internal.connectors.forCall, { turnId, connectorId: "crm" })).not.toBeNull();
		expect(await s.t.mutation(internal.manageTools.runFor, { turnId, tool: "channels.manage", input: { request: { action: "set_topic", chat: room, topic: SECRET } } })).not.toHaveProperty("error");
		expect((await s.t.run((ctx) => ctx.db.get("chats", room)))!.usedPlaces).toContain(s.install._id);
		await s.t.mutation(internal.turns.finishReply, { turnId });
		await s.owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: false });
		expect(await s.owner.query(api.chats.get, { chatId: room })).not.toBeNull();
		for (const viewer of [s.dana, s.crew]) expect(await viewer.query(api.chats.get, { chatId: room })).toBeNull();
		await s.owner.mutation(api.chats.updateChannel, { chatId: room, topic: "Owner can still edit" });
		const next = await s.start(s.owner, room);
		expect(await s.t.mutation(internal.turns.turnContext, { turnId: next })).not.toBeNull();
		await s.t.mutation(internal.turns.updateReply, { turnId: next, text: "Still working", parts: [{ type: "text", text: "Still working" }] });
		await s.t.mutation(internal.turns.finishReply, { turnId: next });
		expect((await s.t.run((ctx) => ctx.db.get("agentTurns", next)))!.status).toBe("done");
		expect(JSON.stringify(await s.owner.query(api.messages.list, { chatId: room }))).toContain("Still working");
	});

	it("continues scheduled automations made by a workspace Owner after uninstall", async () => {
		const s = await connectorSetup();
		await s.finish();
		const turnId = await s.start(s.owner);
		expect(await s.t.mutation(internal.connectors.forCall, { turnId, connectorId: "crm" })).not.toBeNull();
		const made = await s.t.mutation(internal.automationTools.createFor, { turnId, input: { name: "CRM digest", prompt: SECRET, trigger: { type: "schedule", cron: "0 9 * * *" }, runsFor: "me" } });
		if (!("created" in made)) throw new Error(JSON.stringify(made));
		const install = (await s.t.run((ctx) => ctx.db.query("automationInstalls").collect())).find((i) => i.automationId === made.created)!;
		expect(install.usedPlaces).toContain(s.install._id);
		await s.t.mutation(internal.turns.finishReply, { turnId });
		await s.owner.mutation(api.connectors.setInstalled, { connectorId: "crm", installed: false });
		expect((await s.owner.query(api.automations.list)).some((a) => a.id === made.created)).toBe(true);
		await s.t.mutation(internal.automationRuns.tick, { now: Date.now() + 2 * 86_400_000 });
		const run = (await s.t.run((ctx) => ctx.db.query("agentTurns").collect())).find((t) => t.chatId !== s.chat._id)!;
		expect(run.actorId).toBe(s.owner.userId);
		expect(JSON.stringify(await s.t.mutation(internal.turns.turnContext, { turnId: run._id }))).toContain(SECRET);
		expect(await s.t.mutation(internal.connectors.forCall, { turnId: run._id, connectorId: "crm" })).toBeNull();
		await s.t.mutation(internal.turns.updateReply, { turnId: run._id, text: SECRET, parts: [{ type: "text", text: SECRET }] });
		await s.t.mutation(internal.turns.finishReply, { turnId: run._id });
		expect((await s.t.run((ctx) => ctx.db.get("agentTurns", run._id)))!.status).toBe("done");
	});

	it("keeps connector sources on posts and permits only authorized people to share the answer", async () => {
		const s = await connectorSetup();
		await s.readConnector();
		const post = await s.t.mutation(internal.manageTools.runFor, { turnId: s.turnId, tool: "chat.manage", input: { request: { action: "send", chat: "#general", text: SECRET } } }) as { messageId: Id<"chatMessages"> };
		expect(post).toHaveProperty("messageId");
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", post.messageId)))!.usedPlaces).toContain(s.install._id);
		expect(JSON.stringify(await s.crew.query(api.messages.list, { chatId: s.chat._id }))).not.toContain(SECRET);
		await s.t.mutation(internal.activity.log, { turnId: s.turnId, callId: "crm-read", tool: "crm.search", changes: false, input: SECRET, output: SECRET });
		await s.finish();
		await expect(s.crew.mutation(api.messages.share, { messageId: s.replyId })).rejects.toThrow("can't see");
		await s.dana.mutation(api.messages.share, { messageId: s.replyId });
		expect((await s.reply(s.crew)).text).toBe(SECRET);
		expect(await s.crew.query(api.activity.forReply, { replyId: s.replyId })).toEqual([]);
	});

	it.each(["record", "page", "picture"] as const)("refuses a public %s write after a connector read", async (kind) => {
		const s = await connectorSetup();
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "records.edit", on: true });
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "pages.edit", on: true });
		const page = await s.owner.mutation(api.pages.create, { title: "Public notes" });
		const clients = (await s.owner.query(api.recordTypes.list)).find((t) => t.key === "client")!;
		await s.readConnector();
		if (kind === "record") {
			const result = await s.t.mutation(internal.recordTools.saveFor, { turnId: s.turnId, input: { type: clients.key, values: { name: SECRET } } });
			expect(result).toHaveProperty("error", expect.stringContaining("wider audience"));
		} else if (kind === "page") {
			const result = await s.t.mutation(internal.pageTools.writeFor, { turnId: s.turnId, input: { page, title: SECRET } });
			expect(result).toHaveProperty("error", expect.stringContaining("wider audience"));
		} else {
			const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob(["picture"], { type: "image/png" })));
			await s.t.run((ctx) => ctx.db.patch(s.replyId, { attachments: [{ storageId, name: "crm.png", type: "image/png", size: 7 }] }));
			await s.finish();
			const next = await s.start(s.dana);
			const file = `${s.replyId}/0`;
			const copied = await s.t.action(internal.files.copyFor, { turnId: next, ids: [file], picture: true });
			if (!("copies" in copied)) throw new Error(copied.error);
			const copy = copied.copies[file]!;
			const url = (await s.t.run((ctx) => ctx.storage.getUrl(copy)))!;
			const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", next)))!.replyId!;
			expect((await s.t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces).toContain(s.install._id);
			const result = await s.t.mutation(internal.pageTools.writeFor, { turnId: next, input: { page }, pictures: [{ storageId: copy, url }] });
			expect(result).toHaveProperty("error", expect.stringContaining("wider audience"));
			expect(await s.t.run((ctx) => ctx.db.query("pageImages").collect())).toEqual([]);
		}
	});

	it("refuses a public decision reaction after a connector read", async () => {
		const s = await connectorSetup();
		await s.readConnector();
		const turn = await decideReaction(s.t, s.turnId, s.turn.triggerId!, "👍");
		expect(turn.status).toBe("error");
		expect(await s.t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([]);
	});
});

describe("private agent replies", () => {
	it("records reads before returning results, masks every content field, and shows the reply after a role grant", async () => {
		const s = await setup();
		expect(JSON.stringify(await s.read())).toContain(SECRET);
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.usedPlaces).toContain(s.deals);
		await s.finish();
		const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob([SECRET], { type: "text/plain" })));
		await s.t.run(async (ctx) => {
			const previewId = await ctx.db.insert("linkPreviews", { workspaceId: s.turn.workspaceId, url: "https://example.com/private", title: SECRET, fetchedAt: Date.now() });
			await ctx.db.patch(s.replyId, { attachments: [{ storageId, name: `${SECRET}.txt`, type: "text/plain", size: SECRET.length }], linkPreviews: [{ previewId }], error: SECRET });
		});
		const visible = await s.reply(s.dana);
		expect(visible.text).toBe(SECRET);
		expect(visible.privacy).toMatchObject({ hidden: false, label: "Only Office and Owners can see this", why: "Uses the Deals database", share: "Only Office and Owners can see Deals. Share just the answer? Tool inputs, outputs and approval reasons stay private." });
		const hidden = await s.reply(s.crew);
		expect(hidden.text).toBe("🔒 Replied to Dana. Only Office and Owners can see this.");
		expect(hidden).toMatchObject({ parts: [], attachments: [], linkPreviews: [], reactions: [], stats: null, error: null, pause: null });
		expect(JSON.stringify(hidden)).not.toContain(SECRET);
		const member = (await s.owner.query(api.workspace.team))!.members.find((m) => m.userId === s.crew.userId)!;
		await s.owner.mutation(api.workspace.setRoles, { id: member.id, roles: [s.office] });
		expect((await s.reply(s.crew)).text).toBe(SECRET);
	});

	it("switches the stream to a placeholder as soon as a restricted read commits, including on alpha.9 calls", async () => {
		const s = await setup();
		await s.write("Let me check that.");
		expect((await s.crew.query(api.messages.stream, { messageId: s.replyId }))!.text).toBe("Let me check that.");
		await s.read();
		await s.write();
		const stream = await s.crew.query(api.messages.stream, { messageId: s.replyId });
		expect(stream).toMatchObject({ text: "🔒 Replied to Dana. Only Office and Owners can see this.", parts: [] });
		expect(JSON.stringify(stream)).not.toContain(SECRET);
		expect((await s.dana.query(api.messages.stream, { messageId: s.replyId }))!.text).toBe(SECRET);
		// Old clients send the existing query arguments; security never depends on a new capability flag.
		expect(JSON.stringify(await s.reply(s.crew))).not.toContain(SECRET);
	});

	it("hides tool inputs, outputs, errors, approvals and typing steps with the turn", async () => {
		const s = await setup();
		await s.read();
		await s.t.mutation(internal.activity.log, { turnId: s.turnId, callId: "c1", tool: "records.get", changes: false, input: SECRET, output: SECRET, error: SECRET });
		await s.t.mutation(internal.approvals.request, { turnId: s.turnId, callId: "c2", tool: "chat.send", input: JSON.stringify({ text: SECRET }), risk: "outside", why: SECRET });
		await s.t.mutation(internal.turns.setStep, { turnId: s.turnId, label: SECRET });
		expect(await s.crew.query(api.activity.forReply, { replyId: s.replyId })).toEqual([]);
		expect(await s.crew.query(api.approvals.forReply, { replyId: s.replyId })).toEqual([]);
		expect(JSON.stringify(await s.crew.query(api.activity.list, {}))).not.toContain(SECRET);
		expect(JSON.stringify(await s.crew.query(api.typing.list, { chatId: s.chat._id }))).not.toContain(SECRET);
		expect(JSON.stringify(await s.dana.query(api.activity.forReply, { replyId: s.replyId }))).toContain(SECRET);
		expect(JSON.stringify(await s.dana.query(api.approvals.forReply, { replyId: s.replyId }))).toContain(SECRET);
	});

	it("requires the sharer to see the reply, records them, and reveals the turn to the chat", async () => {
		const s = await setup();
		await s.read(); await s.finish();
		await expect(s.crew.mutation(api.messages.share, { messageId: s.replyId })).rejects.toThrow("can't see");
		await s.owner.mutation(api.messages.share, { messageId: s.replyId });
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.sharedBy).toBe(s.owner.userId);
		expect(await s.reply(s.crew)).toMatchObject({ text: SECRET, privacy: { hidden: false, label: "Shared by owner@co.com" } });
		await s.dana.mutation(api.messages.share, { messageId: s.replyId });
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.sharedBy).toBe(s.owner.userId);
	});

	it("omits hidden session turns and thread parents, and propagates sources when an authorized agent reads a reply", async () => {
		const s = await setup();
		await s.read();
		await s.t.mutation(internal.turns.savePrompt, { turnId: s.turnId, prompt: SECRET });
		await s.finish();
		const crewTurn = await s.start(s.crew);
		expect(JSON.stringify(await s.t.mutation(internal.turns.turnContext, { turnId: crewTurn }))).not.toContain(SECRET);
		expect(JSON.stringify(await s.t.mutation(internal.chatTools.readFor, { turnId: crewTurn, threadOf: s.replyId }))).not.toContain(SECRET);
		await s.t.mutation(internal.turns.finishReply, { turnId: crewTurn });
		const danaTurn = await s.start(s.dana);
		const read = await s.t.mutation(internal.chatTools.readFor, { turnId: danaTurn, chat: "#general" });
		expect(JSON.stringify(read)).toContain(SECRET);
		const turn = (await s.t.run((ctx) => ctx.db.get("agentTurns", danaTurn)))!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", turn.replyId!)))!.usedPlaces).toContain(s.deals);
	});

	it("keeps restricted session summaries out and replays the viewer's readable older turns", async () => {
		const s = await setup();
		await s.read(); await s.finish();
		await s.t.run((ctx) => ctx.db.patch(s.turn.sessionId!, { summary: SECRET, summaryPlaces: [s.deals], summarizedUpTo: Date.now() + 100 }));
		const id = await s.start(s.crew);
		const context = await s.t.mutation(internal.turns.turnContext, { turnId: id });
		expect(context.session.summary).toBeNull();
		expect(JSON.stringify(context)).not.toContain(SECRET);
	});

	it("does not extract restricted content into team memory", async () => {
		const s = await setup();
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
		await s.read();
		await expect(s.t.mutation(internal.memory.createFor, { turnId: s.turnId, scope: "workspace", content: SECRET })).rejects.toThrow("Only Office and Owners");
		expect(JSON.stringify(await s.crew.query(api.memory.list))).not.toContain(SECRET);
	});

	it("tracks restricted pages and channels and intersects their role lists", async () => {
		const s = await setup();
		const page = await s.owner.mutation(api.pages.create, { title: "Plans" });
		await s.owner.mutation(api.pages.setAccess, { pageId: page, access: [{ role: s.office, level: "view" }] });
		const room = await s.owner.mutation(api.chats.createChannel, { name: "deals-room", private: false });
		await s.owner.mutation(api.chats.setAccess, { chatId: room, access: [{ role: s.office, level: "view" }] });
		await s.t.mutation(internal.pageTools.readFor, { turnId: s.turnId, page });
		await s.t.mutation(internal.chatTools.readFor, { turnId: s.turnId, chat: room });
		await s.read();
		const used = (await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.usedPlaces;
		expect(used).toEqual(expect.arrayContaining([page, room, s.deals]));
		await s.finish();
		expect((await s.reply(s.dana)).privacy!.label).toBe("Only Office and Owners can see this");
		await s.owner.mutation(api.pages.setAccess, { pageId: page, access: [] });
		expect((await s.reply(s.dana)).privacy).toMatchObject({ hidden: true, label: "Replied to Dana. Only Owners can see this." });
	});

	it("refuses guessed attachment ids and inherits sources on follow-ups", async () => {
		const s = await setup(); await s.read();
		const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob([SECRET], { type: "text/plain" })));
		await s.t.run((ctx) => ctx.db.patch(s.replyId, { attachments: [{ storageId, name: "secret.txt", type: "text/plain", size: SECRET.length }] }));
		await s.t.mutation(internal.wakeups.createFor, { turnId: s.turnId, input: { note: SECRET, in: { hours: 1 } } });
		const wakeup = (await s.t.run((ctx) => ctx.db.query("wakeups").collect()))[0]!;
		expect(wakeup.usedPlaces).toContain(s.deals);
		expect(JSON.stringify(await s.crew.query(api.wakeups.list, {}))).not.toContain(SECRET);
		await s.finish();
		const id = await s.start(s.crew);
		expect(await s.t.mutation(internal.files.readFor, { turnId: id, id: `${s.replyId}/0` })).toBeNull();
	});

	it("carries another private conversation's audience into a shared reply", async () => {
		const s = await setup();
		const dm = await s.dana.mutation(api.chats.openDm, { userIds: [s.owner.userId], agentIds: [] });
		await s.dana.mutation(api.messages.send, { chatId: dm, text: SECRET, mentions: noMentions });
		expect(JSON.stringify(await s.t.mutation(internal.chatTools.readFor, { turnId: s.turnId, chat: dm }))).toContain(SECRET);
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.usedPlaces).toContain(dm);
		await s.finish();
		expect(JSON.stringify(await s.reply(s.crew))).not.toContain(SECRET);
	});

	it("records compaction sources before the summary call and checks them when the summary is read", async () => {
		const s = await setup(); await s.read();
		await s.t.mutation(internal.turns.savePrompt, { turnId: s.turnId, prompt: "Deal summary" });
		await s.finish();
		const id = await s.start(s.crew);
		await s.t.mutation(internal.turns.savePrompt, { turnId: id, prompt: "Public conversation" });
		await s.t.mutation(internal.turns.finishReply, { turnId: id });
		const compact = await s.t.mutation(internal.turns.startCompaction, { sessionId: s.turn.sessionId!, keepTokens: 1 });
		expect(compact).not.toBeNull();
		await s.t.mutation(internal.turns.finishCompaction, { sessionId: s.turn.sessionId!, result: { summary: SECRET, upTo: compact!.upTo, costUsd: 0 } });
		expect((await s.t.run((ctx) => ctx.db.get("agentSessions", s.turn.sessionId!)))!.summaryPlaces).toContain(s.deals);
		const next = await s.start(s.crew);
		expect(JSON.stringify(await s.t.mutation(internal.turns.turnContext, { turnId: next }))).not.toContain(SECRET);
	});

	it("checks sources in one-person and group DMs, including after access is lost", async () => {
		const s = await setup(); await s.finish();
		const dm = await s.dana.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const id = await s.start(s.dana, dm);
		await s.t.mutation(internal.recordTools.getFor, { turnId: id, id: s.deal });
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", id)))!.replyId!;
		await s.t.mutation(internal.turns.updateReply, { turnId: id, text: SECRET, parts: [{ type: "text", text: SECRET }] });
		expect((await s.dana.query(api.messages.list, { chatId: dm })).find((m) => m._id === replyId)!.privacy).toMatchObject({ hidden: false });
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: s.deals, access: [] });
		expect((await s.dana.query(api.messages.list, { chatId: dm })).find((m) => m._id === replyId)!.privacy).toMatchObject({ hidden: true });
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: s.deals, access: [{ role: s.office, level: "view" }] });
		const group = await s.dana.mutation(api.chats.openDm, { userIds: [s.crew.userId], agentIds: [s.companybot._id] });
		const groupTurn = await s.start(s.dana, group);
		await s.t.mutation(internal.recordTools.getFor, { turnId: groupTurn, id: s.deal });
		await s.t.mutation(internal.turns.updateReply, { turnId: groupTurn, text: SECRET, parts: [{ type: "text", text: SECRET }] });
		await s.t.mutation(internal.turns.finishReply, { turnId: groupTurn });
		expect(JSON.stringify(await s.crew.query(api.messages.list, { chatId: group }))).not.toContain(SECRET);
		expect(JSON.stringify(await s.crew.query(api.chats.alerts))).not.toContain(SECRET);
	});

	it("sweeps chat-reading queries and tools as Crew: no source names, ids or secret content", async () => {
		const s = await setup(); await s.read();
		const page = await s.owner.mutation(api.pages.create, { title: "Vaultplan" });
		await s.owner.mutation(api.pages.setAccess, { pageId: page, access: [{ role: s.office, level: "view" }] });
		const room = await s.owner.mutation(api.chats.createChannel, { name: "vaultroom", private: true });
		await s.owner.mutation(api.chats.addMembers, { chatId: room, userIds: [s.dana.userId], agentIds: [] });
		await s.t.mutation(internal.pageTools.readFor, { turnId: s.turnId, page });
		await s.t.mutation(internal.chatTools.readFor, { turnId: s.turnId, chat: room });
		await s.finish();
		await s.t.run(async (ctx) => {
			await ctx.db.patch(s.replyId, { lastReplyAt: Date.now(), replyCount: 1 });
			await ctx.db.insert("userMentions", { at: Date.now(), chatId: s.chat._id, messageId: s.replyId, userId: s.crew.userId });
		});
		const id = await s.start(s.crew);
		const seen = {
			list: await s.crew.query(api.messages.list, { chatId: s.chat._id }),
			thread: await s.crew.query(api.messages.list, { chatId: s.chat._id, threadId: s.replyId }),
			stream: await s.crew.query(api.messages.stream, { messageId: s.replyId }),
			chats: await s.crew.query(api.chats.list),
			get: await s.crew.query(api.chats.get, { chatId: s.chat._id }),
			threads: await s.crew.query(api.chats.activeThreads, { now: Date.now() }),
			alerts: await s.crew.query(api.chats.alerts),
			place: await s.crew.query(api.chats.place, { chatId: s.chat._id }),
			activity: await s.crew.query(api.activity.list, {}),
			calls: await s.crew.query(api.activity.forReply, { replyId: s.replyId }),
			approvals: await s.crew.query(api.approvals.forReply, { replyId: s.replyId }),
			discussion: await s.crew.query(api.records.discussion, { recordId: s.deal }),
			context: await s.t.mutation(internal.turns.turnContext, { turnId: id }),
			read: await s.t.mutation(internal.chatTools.readFor, { turnId: id, chat: "#general" }),
			search: await s.t.mutation(internal.chatTools.searchFor, { turnId: id, query: "Quartz" }),
			history: await s.t.mutation(internal.recordTools.historyFor, { turnId: id }),
			agentActivity: await s.t.mutation(internal.recordTools.historyFor, { turnId: id, source: "agents" }),
			router: await s.t.query(internal.router.context, { messageId: (await s.t.run((ctx) => ctx.db.get("agentTurns", id)))!.triggerId! }),
		};
		const text = JSON.stringify(seen);
		for (const hidden of [SECRET, "Deals", "Vaultplan", "vaultroom", s.deals, s.deal, page, room]) expect(text).not.toContain(hidden);
	});

	it("does not deliver a hidden message.posted payload to automations", async () => {
		const s = await setup(); await s.read();
		await s.owner.mutation(api.automations.create, { config: { name: "Digest", prompt: "Summarize", trigger: { type: "event", event: "message.posted", channelId: s.chat._id } }, agentId: s.companybot._id, audience: "subscribers", timeZone: "UTC" });
		const sent = await s.t.mutation(internal.manageTools.runFor, { turnId: s.turnId, tool: "chat.manage", input: { request: { action: "send", chat: "#general", text: SECRET } } });
		expect(sent).toHaveProperty("messageId");
		expect(JSON.stringify(await s.t.run((ctx) => ctx.db.query("chatMessages").collect()))).not.toContain('"automation":');
	});

	it("keeps server masking out of the compatibility removal list", async () => {
		const code = readFileSync(new URL("../convex/replyPrivacy.ts", import.meta.url), "utf8");
		expect(code).not.toContain("COMPAT" + "(");
	});

	it("bounds replay to the newest readable turns when a summary is hidden", async () => {
		const s = await setup(); await s.finish();
		await s.t.run(async (ctx) => {
			for (let i = 0; i < 100; i++) {
				const text = `Readable answer ${i}: ` + "y".repeat(2000);
				const replyId = await ctx.db.insert("chatMessages", { workspaceId: s.turn.workspaceId, chatId: s.chat._id, authorAgentId: s.companybot._id, text, parts: [], status: "done", mentions: noMentions });
				await ctx.db.insert("agentTurns", { workspaceId: s.turn.workspaceId, chatId: s.chat._id, agentId: s.companybot._id, actorId: s.crew.userId, sessionId: s.turn.sessionId!, replyId, promptPlaces: [], prompt: `Readable request ${i}: ` + "x".repeat(2000), status: "done" });
			}
			await ctx.db.patch(s.turn.sessionId!, { summary: SECRET, summaryPlaces: [s.deals], summarizedUpTo: Date.now() + 100 });
		});
		const turnId = await s.start(s.crew);
		const context = await s.t.mutation(internal.turns.turnContext, { turnId });
		const replay = context.session.turns.map((t) => t.prompt + t.reply).join("");
		expect(approxTokens(replay)).toBeLessThanOrEqual(KEEP_TOKENS);
		expect(replay).toContain("Readable request 99:");
		expect(replay).not.toContain("Readable request 0:");
		expect(replay).not.toContain(SECRET);
	});

	it.each(["private", "restricted"] as const)("retains its own %s channel for writes but excludes it from display privacy", async (kind) => {
		const s = await setup();
		const room = await s.owner.mutation(api.chats.createChannel, { name: "ops", private: kind === "private" });
		if (kind === "private") await s.owner.mutation(api.chats.addMembers, { chatId: room, userIds: [s.dana.userId], agentIds: [] });
		if (kind === "restricted") await s.owner.mutation(api.chats.setAccess, { chatId: room, access: [{ role: s.office, level: "edit" }] });
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
		const turnId = await s.start(s.dana, room);
		await s.t.mutation(internal.turns.turnContext, { turnId });
		const turn = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", turn.replyId!)))!.usedPlaces).toContain(room);
		await s.t.mutation(internal.turns.updateReply, { turnId, text: "Checked.", parts: [{ type: "text", text: "Checked." }] });
		expect((await s.dana.query(api.messages.list, { chatId: room })).find((m) => m._id === turn.replyId)!.privacy).toBeNull();
		await expect(s.t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: "The team meets every Monday." })).rejects.toThrow("wider audience");
	});

	it("names membership audiences, without naming a hidden source to outsiders", async () => {
		const s = await setup();
		const ops = await s.owner.mutation(api.chats.createChannel, { name: "ops", private: true });
		await s.owner.mutation(api.chats.addMembers, { chatId: ops, userIds: [s.dana.userId], agentIds: [] });
		await s.t.mutation(internal.chatTools.readFor, { turnId: s.turnId, chat: ops });
		await s.finish();
		expect((await s.reply(s.dana)).privacy!.label).toBe("Only people in #ops can see this");
		expect((await s.reply(s.crew)).privacy!.label).toBe("Replied to Dana. Only people in a private channel can see this.");
		expect(JSON.stringify(await s.reply(s.crew))).not.toContain("ops");
	});

	it("does not record discarded database metadata or filtered chat search hits", async () => {
		const s = await setup();
		const archived = await s.owner.mutation(api.recordTypes.create, { plural: "Vaultbids" });
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: archived, access: [{ role: s.office, level: "view" }] });
		await s.owner.mutation(api.trash.move, { kind: "database", id: archived });
		const types = await s.t.mutation(internal.recordTools.typesFor, { turnId: s.turnId });
		expect(JSON.stringify(types)).not.toContain("Vaultbids");
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.usedPlaces).not.toContain(archived);
		await s.finish();
		// Dana can open Deals but is not in this private room: its search hit must be discarded first.
		const room = await s.owner.mutation(api.chats.createChannel, { name: "other-room", private: true });
		await s.t.run((ctx) => ctx.db.insert("chatMessages", { workspaceId: s.turn.workspaceId, chatId: room, authorAgentId: s.companybot._id, text: "Discarded quartz", parts: [], status: "done", mentions: noMentions, usedPlaces: [s.deals] }));
		const turnId = await s.start(s.dana);
		expect(await s.t.mutation(internal.chatTools.searchFor, { turnId, query: "Discarded" })).toEqual({ messages: [] });
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces ?? []).toEqual([]);
		// The pure check itself also cannot write sources, even for an allowed private reply.
		await s.t.run(async (ctx) => {
			const member = (await memberOf(ctx, s.dana.userId, s.turn.workspaceId))!;
			member.replyId = replyId;
			expect(await canReadReply(ctx, member, await ctx.db.get("chatMessages", s.replyId))).toBe(true);
		});
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces ?? []).toEqual([]);
	});

	it("refuses Share during streaming and when the reader only has View in the destination", async () => {
		const s = await setup(); await s.read();
		await expect(s.owner.mutation(api.messages.share, { messageId: s.replyId })).rejects.toThrow("finishes");
		await s.finish();
		await s.owner.mutation(api.chats.setAccess, { chatId: s.chat._id, access: [{ role: "everyone", level: "view" }] });
		await expect(s.dana.mutation(api.messages.share, { messageId: s.replyId })).rejects.toThrow("post");
		expect((await s.reply(s.dana)).privacy!.share).toBeNull();
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.sharedBy).toBeUndefined();
	});

	it("clears sharedBy when an agent edits a shared message using restricted sources", async () => {
		const s = await setup(); await s.read();
		const sent = await s.t.mutation(internal.manageTools.runFor, { turnId: s.turnId, tool: "chat.manage", input: { request: { action: "send", chat: "#general", text: "First answer" } } }) as { messageId: Id<"chatMessages"> };
		await s.owner.mutation(api.messages.share, { messageId: sent.messageId });
		await s.finish("Ready");
		const editor = await s.start(s.dana);
		const edit = await s.t.mutation(internal.manageTools.runFor, { turnId: editor, tool: "chat.manage", input: { request: { action: "edit", messageId: sent.messageId, text: SECRET } } });
		expect(edit).not.toHaveProperty("error");
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", sent.messageId)))!.sharedBy).toBeUndefined();
		expect(JSON.stringify(await s.crew.query(api.messages.list, { chatId: s.chat._id }))).not.toContain(SECRET);
	});

	it("refuses approval decisions and claims after the actor loses a source", async () => {
		const s = await setup(); await s.read();
		const { approvalId } = await s.t.mutation(internal.approvals.request, { turnId: s.turnId, callId: "private-call", tool: "chat.manage", input: JSON.stringify({ text: SECRET }), risk: "outside" });
		await s.finish();
		const approval = (await s.t.run((ctx) => ctx.db.get("approvals", approvalId)))!;
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: s.deals, access: [] });
		await expect(s.dana.mutation(api.approvals.decide, { approvalId, hash: approval.hash, approve: true, always: false })).rejects.toThrow("Approval not found");
		const turnId = await s.start(s.dana);
		await s.t.run(async (ctx) => { await ctx.db.patch(approvalId, { status: "approved" }); await ctx.db.patch(turnId, { approvalId }); });
		expect(await s.t.mutation(internal.approvals.claim, { approvalId, turnId })).toBeNull();
		expect((await s.t.run((ctx) => ctx.db.get("approvals", approvalId)))!.status).toBe("approved");
	});

	it("filters hidden steering messages before adding text or provenance", async () => {
		const s = await setup(); await s.finish();
		const turnId = await s.start(s.crew);
		vi.setSystemTime(Date.now() + 10);
		const hidden = await s.crew.mutation(api.messages.send, { chatId: s.chat._id, text: SECRET, mentions: noMentions });
		await s.t.run((ctx) => ctx.db.patch(hidden, { usedPlaces: [s.deals] }));
		await s.crew.mutation(api.messages.send, { chatId: s.chat._id, text: "Keep it short", mentions: noMentions });
		const result = await s.t.mutation(internal.turns.steer, { turnId });
		expect(result!.note).toContain("Keep it short");
		expect(JSON.stringify(result)).not.toContain(SECRET);
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces ?? []).toEqual([]);
	});

	it("keeps legacy Activity with an expired wakeup visible only to its actor", async () => {
		const s = await setup();
		await s.t.mutation(internal.wakeups.createFor, { turnId: s.turnId, input: { note: "Old follow-up", in: { hours: 1 } } });
		await s.t.run(async (ctx) => {
			const wakeup = (await ctx.db.query("wakeups").first())!;
			await ctx.db.insert("agentActivity", { workspaceId: s.turn.workspaceId, agentId: s.companybot._id, actorId: s.dana.userId, chatId: s.chat._id, callId: "old-wake", tool: "followups.create", input: SECRET, changes: false, status: "done", wake: { wakeupId: wakeup._id, outcome: "ran" } });
			await ctx.db.delete(wakeup._id);
		});
		expect(JSON.stringify(await s.dana.query(api.activity.list, {}))).toContain(SECRET);
		expect(JSON.stringify(await s.crew.query(api.activity.list, {}))).not.toContain(SECRET);
	});

	it("blocks restricted facts in team skill and automation creates, edits and audience changes", async () => {
		const s = await setup(); await s.finish();
		const safe = { name: "Team notes", description: "The team's normal process", instructions: "Follow the team's normal process." };
		const skillId = await s.owner.mutation(api.skills.create, { config: safe });
		const config = { name: "Team digest", prompt: "Summarize the day", trigger: { type: "schedule" as const, cron: "0 9 * * *" } };
		const team = await s.owner.mutation(api.automations.create, { config, agentId: s.companybot._id, audience: "subscribers", timeZone: "UTC" });
		const channel = await s.owner.mutation(api.automations.create, { config: { ...config, name: "Channel digest" }, agentId: s.companybot._id, audience: "channel", channelId: s.chat._id, timeZone: "UTC" });
		const personal = await s.owner.mutation(api.automations.create, { config: { ...config, name: "My digest" }, agentId: s.companybot._id, audience: "creator", timeZone: "UTC" });
		await s.t.run(async (ctx) => { const agent = (await ctx.db.get("agents", s.companybot._id))!; await ctx.db.patch(agent._id, { tools: [...new Set([...agent.tools, "skills.edit", "automations.manage"])] }); });
		const turnId = await s.start(s.owner);
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		expect(await s.t.mutation(internal.skills.createFor, { turnId, audience: "team", config: { ...safe, instructions: SECRET } })).toHaveProperty("error", expect.stringContaining("restricted places"));
		const manage = (tool: string, request: object) => s.t.mutation(internal.manageTools.runFor, { turnId, tool, input: { request } });
		expect(await manage("skills.edit", { action: "edit", id: skillId, config: { ...safe, instructions: SECRET }, expectedVersion: 1 })).toHaveProperty("error", expect.stringContaining("restricted places"));
		for (const runsFor of ["anyone", "#general"]) expect(await s.t.mutation(internal.automationTools.createFor, { turnId, input: { name: "Secret digest", prompt: SECRET, trigger: { type: "schedule", cron: "0 9 * * *" }, runsFor } })).toHaveProperty("error", expect.stringContaining("restricted places"));
		for (const id of [team, channel]) expect(await manage("automations.manage", { action: "edit", id, config: { ...config, prompt: SECRET }, expectedVersion: 1 })).toHaveProperty("error", expect.stringContaining("restricted places"));
		expect(await manage("automations.manage", { action: "set_audience", id: personal, audience: "subscribers" })).toHaveProperty("error", expect.stringContaining("restricted places"));
		expect(JSON.stringify(await s.crew.query(api.skills.list))).not.toContain(SECRET);
		expect(JSON.stringify(await s.crew.query(api.automations.list))).not.toContain(SECRET);
	});


	it("does not record a search hit beyond the output cap", async () => {
		const s = await setup();
		const last = await s.t.run(async (ctx) => {
			for (let i = 0; i < 21; i++) await ctx.db.insert("chatMessages", { workspaceId: s.turn.workspaceId, chatId: s.chat._id, authorUserId: s.dana.userId, text: "Captest quartz", parts: [], status: "done", mentions: noMentions });
			const hits = await ctx.db.query("chatMessages").withSearchIndex("search_text", (q) => q.search("text", "Captest").eq("workspaceId", s.turn.workspaceId)).take(21);
			const last = hits[20]!._id;
			await ctx.db.patch(last, { usedPlaces: [s.deals] });
			return last;
		});
		const found = await s.t.mutation(internal.chatTools.searchFor, { turnId: s.turnId, query: "Captest" });
		expect(found).toHaveProperty("messages", expect.any(Array));
		if (!("messages" in found)) throw new Error("Search failed");
		expect(found.messages).toHaveLength(20);
		expect(found.messages.map((m) => m.id)).not.toContain(last);
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.usedPlaces ?? []).toEqual([]);
	});


	it.each(["private", "restricted"] as const)("masks sends and edits from a %s source channel in another chat", async (kind) => {
		const s = await setup();
		const ops = await s.owner.mutation(api.chats.createChannel, { name: "ops", private: kind === "private" });
		await s.owner.mutation(api.chats.addMembers, { chatId: ops, userIds: [s.dana.userId], agentIds: [] });
		if (kind === "restricted") await s.owner.mutation(api.chats.setAccess, { chatId: ops, access: [{ role: s.office, level: "edit" }] });
		const turnId = await s.start(s.dana, ops);
		const sent = await s.t.mutation(internal.manageTools.runFor, { turnId, tool: "chat.manage", input: { request: { action: "send", chat: "#general", text: SECRET } } }) as { messageId: Id<"chatMessages"> };
		expect(sent).toHaveProperty("messageId");
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", sent.messageId)))!.usedPlaces).toEqual([ops]);
		expect(JSON.stringify(await s.crew.query(api.messages.list, { chatId: s.chat._id }))).not.toContain(SECRET);
		// Editing an older, originally public message must stamp the origin too.
		await s.finish("Ready");
		const editor = await s.start(s.dana);
		const old = await s.t.mutation(internal.manageTools.runFor, { turnId: editor, tool: "chat.manage", input: { request: { action: "send", chat: "#general", text: "Public note" } } }) as { messageId: Id<"chatMessages"> };
		const edited = await s.t.mutation(internal.manageTools.runFor, { turnId, tool: "chat.manage", input: { request: { action: "edit", messageId: old.messageId, text: SECRET } } });
		expect(edited).not.toHaveProperty("error");
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", old.messageId)))!.usedPlaces).toEqual([ops]);
		expect(JSON.stringify(await s.crew.query(api.messages.list, { chatId: s.chat._id }))).not.toContain(SECRET);
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces).toContain(ops);
	});

	it("does not taint empty public database lookups or unrelated returned search rows", async () => {
		const s = await setup();
		const clients = (await s.owner.query(api.recordTypes.list)).find((t) => t.key === "client")!._id;
		const empty = await s.t.mutation(internal.recordTools.findFor, { turnId: s.turnId, input: { type: "Clients", numItems: 20 } });
		expect(empty).toHaveProperty("rows", []);
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.usedPlaces ?? []).toEqual([]);
		const found = await s.t.mutation(internal.recordTools.findFor, { turnId: s.turnId, input: { search: "NoSuchMatch", numItems: 20 } });
		expect(found).toHaveProperty("rows", []);
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.usedPlaces ?? []).toEqual([]);
		await s.owner.mutation(api.records.create, { typeId: clients, values: { name: "OnlyPublicMatch" } });
		const rows = await s.t.mutation(internal.recordTools.findFor, { turnId: s.turnId, input: { search: "OnlyPublicMatch", numItems: 20 } });
		expect(rows).toHaveProperty("rows", [expect.objectContaining({ name: "OnlyPublicMatch" })]);
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", s.replyId)))!.usedPlaces ?? []).toEqual([]);
		await s.t.mutation(internal.turns.updateReply, { turnId: s.turnId, text: "No records yet", parts: [{ type: "text", text: "No records yet" }] });
		await s.t.mutation(internal.turns.finishReply, { turnId: s.turnId });
		expect((await s.reply(s.crew)).privacy).toBeNull();
	});

	it.each(["name", "description", "instructions"] as const)("refuses a restricted fact in another agent's %s", async (property) => {
		const s = await setup(); await s.finish();
		const target = (await s.owner.query(api.agents.list)).find((a) => a._id !== s.companybot._id)!;
		await s.t.run(async (ctx) => { const agent = (await ctx.db.get("agents", s.companybot._id))!; await ctx.db.patch(agent._id, { tools: [...new Set([...agent.tools, "agents.manage"])] }); });
		const turnId = await s.start(s.owner);
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		const result = await s.t.mutation(internal.manageTools.runFor, { turnId, tool: "agents.manage", input: { request: { action: "update", id: target._id, expectedVersion: target.version, [property]: SECRET } } });
		expect(result).toHaveProperty("error", expect.stringContaining("restricted places"));
		expect(JSON.stringify(await s.crew.query(api.agents.list))).not.toContain(SECRET);
	});

	it("refuses restricted facts in channel create, rename, topic and public profile text", async () => {
		const s = await setup(); await s.finish();
		const turnId = await s.start(s.owner);
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		const manage = (tool: string, request: object) => s.t.mutation(internal.manageTools.runFor, { turnId, tool, input: { request } });
		for (const request of [
			{ action: "create", name: "new-room", private: false, topic: SECRET },
			{ action: "rename", chat: "#general", name: SECRET },
			{ action: "set_topic", chat: "#general", topic: SECRET },
		]) expect(await manage("channels.manage", request)).toHaveProperty("error", expect.stringContaining("restricted places"));
		expect(await manage("workspace.settings", { action: "update_preferences", displayName: SECRET })).toHaveProperty("error", expect.stringContaining("restricted places"));
		expect(JSON.stringify(await s.crew.query(api.chats.list))).not.toContain(SECRET);
		expect(JSON.stringify(await s.crew.query(api.workspace.team))).not.toContain(SECRET);
	});

	it("guards shared database, field, record, view, page and workspace text in their common writers", async () => {
		const s = await setup(); await s.finish();
		const type = (await s.owner.query(api.recordTypes.list)).find((t) => t.key === "client")!;
		const record = await s.owner.mutation(api.records.create, { typeId: type._id, values: { name: "Public client" } });
		const pageId = await s.owner.mutation(api.pages.create, { title: "Public page" });
		const field = type.fields.find((f) => f.key === "name")!;
		const turnId = await s.start(s.owner);
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		const run = (write: (ctx: MutationCtx, who: Who) => Promise<unknown>) => s.t.run(async (ctx) => {
			const member = (await memberOf(ctx, s.owner.userId, s.turn.workspaceId))!;
			member.replyId = (await ctx.db.get("agentTurns", turnId))!.replyId!;
			return write(ctx, { member, agentId: s.companybot._id });
		});
		const attempts: (() => Promise<unknown>)[] = [
			() => run((ctx, who) => createType(ctx, who, { plural: SECRET })),
			() => run((ctx, who) => updateType(ctx, who, type._id, { plural: SECRET, version: type.version ?? 0 })),
			() => run((ctx, who) => createField(ctx, who, type._id, { label: SECRET, kind: "text" })),
			() => run((ctx, who) => updateField(ctx, who, field._id, { label: SECRET })),
			() => run((ctx, who) => createRecord(ctx, who, type._id, { name: SECRET })),
			() => run((ctx, who) => updateRecord(ctx, who, record, { name: SECRET })),
			() => run((ctx, who) => saveView(ctx, who, type._id, { name: SECRET, filters: [], sort: { field: "name", order: "asc" }, columns: ["name"] })),
			() => run((ctx, who) => createPage(ctx, who, { title: SECRET })),
			() => run(async (ctx, who) => renamePage(ctx, who, (await ctx.db.get("pages", pageId))!, SECRET)),
			() => run(async (ctx, who) => writeBlocks(ctx, who, (await ctx.db.get("pages", pageId))!, JSON.stringify([{ type: "blockContainer", attrs: { id: "leak" }, content: [{ type: "paragraph", content: [{ type: "text", text: SECRET }] }] }]), "replace")),
		];
		for (const write of attempts) await expect(write()).rejects.toThrow("restricted places");
		const changed = await s.t.mutation(internal.manageTools.runFor, { turnId, tool: "workspace.settings", input: { request: { action: "update", name: SECRET, expectedVersion: (await s.owner.query(api.workspace.settings))!.version } } });
		expect(changed).toHaveProperty("error", expect.stringContaining("restricted places"));
		expect(JSON.stringify(await s.crew.query(api.pages.list))).not.toContain(SECRET);
		expect(JSON.stringify(await s.crew.query(api.recordTypes.list))).not.toContain(SECRET);
		// Updating within the original database keeps its audience and remains available.
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: s.deals, access: [{ role: s.office, level: "edit" }] });
		expect(await s.t.mutation(internal.recordTools.saveFor, { turnId, input: { id: s.deal, values: { name: "Still private" } } })).not.toHaveProperty("error");
	});

	it.each(["page", "database"] as const)("a restricted %s retains upstream sources before widening", async (kind) => {
		const s = await setup();
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "pages.edit", on: true });
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "records.edit", on: true });
		const page = await s.owner.mutation(api.pages.create, { title: "Restricted notes" });
		await s.owner.mutation(api.pages.setAccess, { pageId: page, access: [{ role: s.office, level: "edit" }] });
		const clients = (await s.owner.query(api.recordTypes.list)).find((t) => t.key === "client")!;
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: clients._id, access: [{ role: s.office, level: "edit" }] });
		await s.read();
		if (kind === "page") {
			const blocks = JSON.stringify([{ type: "blockContainer", attrs: { id: "private" }, content: [{ type: "paragraph", content: [{ type: "text", text: SECRET }] }] }]);
			expect(await s.t.mutation(internal.pageTools.writeFor, { turnId: s.turnId, input: { page, blocks, mode: "replace" } })).not.toHaveProperty("error");
			expect((await s.t.run((ctx) => ctx.db.get(page)))!.usedPlaces).toContain(s.deals);
			await expect(s.owner.mutation(api.pages.setAccess, { pageId: page, access: null })).rejects.toThrow("Only Office and Owners");
		} else {
			expect(await s.t.mutation(internal.recordTools.saveFor, { turnId: s.turnId, input: { type: clients.key, values: { name: SECRET } } })).not.toHaveProperty("error");
			expect((await s.t.run((ctx) => ctx.db.get(clients._id)))!.usedPlaces).toContain(s.deals);
			await expect(s.owner.mutation(api.recordTypes.setAccess, { typeId: clients._id, access: [{ role: "everyone", level: "edit" }] })).rejects.toThrow("Only Office and Owners");
		}
		await s.finish("Saved.");
		const separate = await s.owner.mutation(api.chats.createChannel, { name: "separate", private: false });
		const next = await s.start(s.dana, separate);
		const read = kind === "page" ? await s.t.mutation(internal.pageTools.readFor, { turnId: next, page }) : await s.t.mutation(internal.recordTools.findFor, { turnId: next, input: { type: clients.key } });
		expect(JSON.stringify(read)).toContain(SECRET);
		const reply = (await s.t.run((ctx) => ctx.db.get("agentTurns", next)))!.replyId!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", reply)))!.usedPlaces).toContain(s.deals);
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: s.deals, access: [] });
		if (kind === "page") await expect(identityOf(s.t, s.dana.userId).query(api.pageSync.getSnapshot, { id: page })).rejects.toThrow("Page not found");
		else expect((await s.dana.query(api.recordTypes.list)).some((t) => t._id === clients._id)).toBe(false);
	});

	it("new private channel text retains sources and refuses adding a wider audience", async () => {
		const s = await setup();
		await s.read();
		const result = await s.t.mutation(internal.manageTools.runFor, { turnId: s.turnId, tool: "channels.manage", input: { request: { action: "create", name: "private-notes", topic: SECRET, private: true } } });
		// Dana needs channels.edit before this can exercise the audience rule.
		expect(result).toHaveProperty("error");
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "channels.edit", on: true });
		const created = await s.t.mutation(internal.manageTools.runFor, { turnId: s.turnId, tool: "channels.manage", input: { request: { action: "create", name: "private-notes", topic: SECRET, private: true } } }) as { chatId: Id<"chats"> };
		expect(created).toHaveProperty("chatId");
		expect((await s.t.run((ctx) => ctx.db.get(created.chatId)))!.usedPlaces).toContain(s.deals);
		await expect(s.dana.mutation(api.chats.addMembers, { chatId: created.chatId, userIds: [s.crew.userId], agentIds: [] })).rejects.toThrow("Only Office and Owners");
		await s.dana.mutation(api.chats.addMembers, { chatId: created.chatId, userIds: [s.owner.userId], agentIds: [] });
		expect((await s.owner.query(api.chats.get, { chatId: created.chatId }))!.topic).toBe(SECRET);
	});

	it.each(["send", "edit"] as const)("an asker can publish their own DM data in a cross-chat thread %s", async (action) => {
		const s = await setup();
		const dm = await s.owner.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const turnId = await s.start(s.owner, dm);
		const parent = await s.owner.mutation(api.messages.send, { chatId: s.chat._id, text: "Public thread", mentions: noMentions });
		const old = await s.t.run((ctx) => ctx.db.insert("chatMessages", { workspaceId: s.turn.workspaceId, chatId: s.chat._id, threadId: parent, authorAgentId: s.companybot._id, actingFor: s.owner.userId, text: "Public note", parts: [], mentions: noMentions, status: "done" }));
		const request = action === "send" ? { action, chat: "#general", threadId: parent, text: SECRET } : { action, messageId: old, text: SECRET };
		const result = await s.t.mutation(internal.manageTools.runFor, { turnId, tool: "chat.manage", input: { request } }) as { messageId: Id<"chatMessages"> };
		expect(result).not.toHaveProperty("error");
		expect((await s.t.run((ctx) => ctx.db.get(result.messageId)))!.usedPlaces ?? []).not.toContain(dm);
		expect(JSON.stringify(await s.crew.query(api.messages.list, { chatId: s.chat._id, threadId: parent }))).toContain(SECRET);
	});

	it("handoff carries sources into the next agent's reply", async () => {
		const s = await setup();
		const { scribe } = await agentsOf(s.owner);
		await s.read();
		await s.finish(`@Scribe ${SECRET}`);
		const next = (await s.t.run((ctx) => ctx.db.query("agentTurns").collect())).find((t) => t.agentId === scribe._id)!;
		expect(next).toBeDefined();
		await s.t.mutation(internal.turns.turnContext, { turnId: next._id });
		expect((await s.t.run((ctx) => ctx.db.get(next.replyId!)))!.usedPlaces).toContain(s.deals);
		expect(JSON.stringify(await s.crew.query(api.messages.list, { chatId: s.chat._id, threadId: next.threadId }))).not.toContain(SECRET);
	});

	it("private asks carry sources through their answer and return wake", async () => {
		const s = await setup();
		const { scribe } = await agentsOf(s.owner);
		await s.read();
		const asked = await s.t.mutation(internal.chains.askFor, { turnId: s.turnId, agent: "Scribe", message: SECRET });
		const thread = "thread" in asked ? asked.thread : undefined;
		if (!thread) throw new Error(JSON.stringify(asked));
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", thread.messageId)))!.usedPlaces).toContain(s.deals);
		await s.t.mutation(internal.turns.finishReply, { turnId: s.turnId });
		const next = (await s.t.run((ctx) => ctx.db.query("agentTurns").collect())).find((t) => t.agentId === scribe._id)!;
		await s.t.mutation(internal.turns.turnContext, { turnId: next._id });
		expect((await s.t.run((ctx) => ctx.db.get(next.replyId!)))!.usedPlaces).toContain(s.deals);
		await s.t.mutation(internal.turns.updateReply, { turnId: next._id, text: SECRET, parts: [{ type: "text", text: SECRET }] });
		await s.t.mutation(internal.turns.finishReply, { turnId: next._id });
		const back = (await s.t.run((ctx) => ctx.db.query("agentTurns").collect())).find((t) => t.wakeupId)!;
		await s.t.mutation(internal.turns.turnContext, { turnId: back._id });
		expect((await s.t.run((ctx) => ctx.db.get(back.replyId!)))!.usedPlaces).toContain(s.deals);
		expect(JSON.stringify(await s.crew.query(api.messages.list, { chatId: s.chat._id, threadId: thread.messageId }))).not.toContain(SECRET);
	});

	it("checks inherited child provenance before widening a parent page", async () => {
		const s = await setup();
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "pages.edit", on: true });
		const parent = await s.owner.mutation(api.pages.create, { title: "Office notes" });
		await s.owner.mutation(api.pages.setAccess, { pageId: parent, access: [{ role: s.office, level: "edit" }] });
		const child = await s.owner.mutation(api.pages.create, { title: "Deal notes", parentId: parent });
		await s.read();
		expect(await s.t.mutation(internal.pageTools.writeFor, { turnId: s.turnId, input: { page: child, blocks: JSON.stringify([{ type: "blockContainer", attrs: { id: "child-note" }, content: [{ type: "paragraph", content: [{ type: "text", text: SECRET }] }] }]), mode: "replace" } })).not.toHaveProperty("error");
		expect((await s.t.run((ctx) => ctx.db.get(child)))!.usedPlaces).toContain(s.deals);
		await expect(s.owner.mutation(api.pages.setAccess, { pageId: parent, access: null })).rejects.toThrow("Only Office and Owners");
		expect((await s.t.run((ctx) => ctx.db.get(parent)))!.access).toEqual([{ role: s.office, level: "edit" }]);
	});

	it("checks combined roles against a reaction's intersected audience", async () => {
		const s = await setup();
		const finance = await s.owner.mutation(api.roles.create, { name: "Finance" });
		const crew = (await s.owner.query(api.roles.list))!.find((r) => r.name === "Member")!.id;
		const pages: Id<"pages">[] = [];
		for (const role of [crew, finance]) {
			const page = await s.owner.mutation(api.pages.create, { title: "Audience" });
			await s.owner.mutation(api.pages.setAccess, { pageId: page, access: [{ role, level: "view" }] });
			pages.push(page);
		}
		const target = await s.t.run((ctx) => ctx.db.insert("chatMessages", { workspaceId: s.turn.workspaceId, chatId: s.chat._id, authorUserId: s.owner.userId, text: "For both roles", parts: [], status: "done", mentions: noMentions, usedPlaces: pages }));
		const writer = await s.owner.mutation(api.chats.createChannel, { name: "writer", private: false });
		const turnId = await s.start(s.owner, writer);
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		// Neither role alone reads the target; someone holding both reads it but cannot read Deals.
		await decideReaction(s.t, turnId, target, "✅");
		expect((await s.t.run(async (ctx) => ctx.db.get((await ctx.db.get("agentTurns", turnId))!.replyId!)))!.error).toContain("Only Office and Owners");
	});

	it("personal-memory reads keep display privacy while allowing the asker to save team memory", async () => {
		const s = await setup();
		await s.owner.mutation(api.memory.create, { agentId: s.companybot._id, scope: "personal", content: SECRET });
		const dm = await s.owner.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const turnId = await s.start(s.owner, dm);
		expect(JSON.stringify(await s.t.mutation(internal.memory.searchFor, { turnId, query: "Quartz" }))).toContain(SECRET);
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		expect((await s.t.run((ctx) => ctx.db.get(replyId)))!.usedPlaces).toContain(s.owner.userId);
		await s.t.mutation(internal.turns.updateReply, { turnId, text: SECRET, parts: [{ type: "text", text: SECRET }] });
		expect((await s.owner.query(api.messages.list, { chatId: dm })).find((m) => m._id === replyId)!.privacy!.label).toBe("Only owner@co.com can see this");
		await expect(s.t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: SECRET })).resolves.toHaveProperty("id");
	});

	it("sharing an answer never releases its private prompt into another viewer's replay", async () => {
		const s = await setup();
		await s.read();
		await s.t.mutation(internal.turns.savePrompt, { turnId: s.turnId, prompt: SECRET });
		await s.finish("I have checked it.");
		await s.owner.mutation(api.messages.share, { messageId: s.replyId });
		const next = await s.start(s.crew);
		const context = await s.t.mutation(internal.turns.turnContext, { turnId: next });
		expect(JSON.stringify(context)).not.toContain(SECRET);
		expect(JSON.stringify(context)).toContain("I have checked it.");
	});

	it("lists 200 deep-page-sourced replies in an agent DM under transaction limits", async () => {
		const s = await setup();
		const dm = await s.owner.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		await s.t.run(async (ctx) => {
			let parentId: Id<"pages"> | undefined;
			for (let depth = 0; depth < 31; depth++) parentId = await ctx.db.insert("pages", { workspaceId: s.turn.workspaceId, title: `Level ${depth}`, parentId, ...(depth === 0 && { access: [] }), archived: false, createdBy: s.owner.userId, updatedBy: s.owner.userId, updatedAt: Date.now() });
			for (let i = 0; i < 200; i++) {
				const page = await ctx.db.insert("pages", { workspaceId: s.turn.workspaceId, title: `Source ${i}`, parentId, archived: false, createdBy: s.owner.userId, updatedBy: s.owner.userId, updatedAt: Date.now() });
				await ctx.db.insert("chatMessages", { workspaceId: s.turn.workspaceId, chatId: dm, authorAgentId: s.companybot._id, text: SECRET, parts: [{ type: "text", text: SECRET }], status: "done", mentions: noMentions, usedPlaces: [page], repliedTo: s.owner.userId });
			}
		});
		const messages = await s.owner.query(api.messages.list, { chatId: dm });
		expect(messages).toHaveLength(200);
		expect(messages.every((m) => m.text === SECRET && m.privacy?.hidden === false)).toBe(true);
	});

	// #230: listing a personal skill used to count as reading it, so one personal skill made every channel reply private.
	// Now only loading its body (skills_load) is a read; outside the asker's own DM it isn't listed at all.
	describe("personal skills", () => {
		const config = { name: "Personal procedure", description: "Private preferences", instructions: SECRET };
		const usedPlaces = async (s: Awaited<ReturnType<typeof setup>>, turnId = s.turnId) =>
			(await s.t.run(async (ctx) => ctx.db.get((await ctx.db.get("agentTurns", turnId))!.replyId!)))!.usedPlaces ?? [];

		it("stay out of a channel turn's index, and its reply stays public when none is loaded", async () => {
			const s = await setup();
			await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
			const skillId = await s.dana.mutation(api.skills.create, { audience: "personal", config });
			const context = await s.t.mutation(internal.turns.turnContext, { turnId: s.turnId });
			expect(systemPrompt(context.agent, context.skills)).not.toContain(skillId);
			expect(JSON.stringify(context)).not.toContain(SECRET);
			expect(JSON.stringify(context)).not.toContain(config.description);
			expect(await usedPlaces(s)).not.toContain(s.dana.userId);
			await expect(s.t.mutation(internal.memory.createFor, { turnId: s.turnId, scope: "workspace", content: "Public fact" })).resolves.toHaveProperty("id");
			await s.finish("Public answer.");
			expect((await s.reply(s.crew)).text).toBe("Public answer.");
		});

		it("named with / in a channel, reach the agent by id and name only, so it can load them", async () => {
			const s = await setup();
			const skillId = await s.dana.mutation(api.skills.create, { audience: "personal", config });
			await s.finish("Earlier answer.");
			const before = await turnsOf(s.t);
			await s.dana.mutation(api.messages.send, { chatId: s.chat._id, text: "/Personal procedure", mentions: { ...noMentions, agentIds: [s.companybot._id], skillIds: [skillId] } });
			const turnId = (await turnsOf(s.t)).find((x) => !before.some((b) => b._id === x._id))!._id;
			const context = await s.t.mutation(internal.turns.turnContext, { turnId });
			expect(context.messages.at(-1)!.skills).toEqual([{ id: skillId, name: config.name }]);
			expect(JSON.stringify(context)).not.toContain(config.description);
			expect(await usedPlaces(s, turnId)).not.toContain(s.dana.userId);
		});

		it("loaded in a channel, make the reply private to their person and refuse wider writes", async () => {
			const s = await setup();
			const skillId = await s.dana.mutation(api.skills.create, { audience: "personal", config });
			await s.t.mutation(internal.turns.turnContext, { turnId: s.turnId });
			expect(await s.t.mutation(internal.skills.loadFor, { turnId: s.turnId, id: skillId })).toEqual({ instructions: SECRET });
			expect(await usedPlaces(s)).toContain(s.dana.userId);
			await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
			await expect(s.t.mutation(internal.memory.createFor, { turnId: s.turnId, scope: "workspace", content: SECRET })).rejects.toThrow("Only Dana");
			await s.finish();
			expect((await s.reply(s.dana)).text).toBe(SECRET);
			expect((await s.reply(s.crew)).text).toBe("🔒 Replied to Dana. Only Dana can see this.");
			// Nobody else can load it, even by id.
			const crewTurn = await s.start(s.crew);
			expect(await s.t.mutation(internal.skills.loadFor, { turnId: crewTurn, id: skillId })).toHaveProperty("error");
		});

		it("work as before in their person's own agent DM", async () => {
			const s = await setup();
			await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
			const skillId = await s.dana.mutation(api.skills.create, { audience: "personal", config });
			const dm = await s.dana.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
			const turnId = await s.start(s.dana, dm);
			const context = await s.t.mutation(internal.turns.turnContext, { turnId });
			expect(systemPrompt(context.agent, context.skills)).toContain(`- ${skillId}: ${config.description}`);
			expect(await s.t.mutation(internal.skills.loadFor, { turnId, id: skillId })).toEqual({ instructions: SECRET });
			expect(await usedPlaces(s, turnId)).toContain(s.dana.userId);
			// Their own data, from their own DM, may be published.
			await expect(s.t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: SECRET })).resolves.toHaveProperty("id");
		});
	});

	it("personal skills retain sources across edits and refuse widening to team", async () => {
		const s = await setup();
		const dm = await s.owner.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const turnId = await s.start(s.owner, dm);
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		const config = { name: "Personal procedure", description: "Private preferences", instructions: SECRET };
		const created = await s.t.mutation(internal.skills.createFor, { turnId, audience: "personal", config });
		if (!("created" in created)) throw new Error(JSON.stringify(created));
		const install = (await s.t.run((ctx) => ctx.db.query("skillInstalls").withIndex("by_workspace", (q) => q.eq("workspaceId", s.turn.workspaceId).eq("skillId", created.created)).first()))!;
		expect(install.usedPlaces).toContain(s.deals);
		await s.owner.mutation(api.skills.save, { skillId: created.created, expectedVersion: 1, config: { ...config, name: "Revised" } });
		await expect(s.owner.mutation(api.skills.share, { skillId: created.created })).rejects.toThrow("wider audience");
		expect(JSON.stringify(await s.crew.query(api.skills.list))).not.toContain(SECRET);
	});

	it("compaction keeps a shared answer's private prompt sources", async () => {
		const s = await setup();
		await s.read();
		await s.t.mutation(internal.turns.savePrompt, { turnId: s.turnId, prompt: SECRET });
		await s.finish("Checked.");
		await s.owner.mutation(api.messages.share, { messageId: s.replyId });
		const next = await s.start(s.crew);
		await s.t.mutation(internal.turns.savePrompt, { turnId: next, prompt: "Public follow-up" });
		await s.t.mutation(internal.turns.finishReply, { turnId: next });
		const compact = await s.t.mutation(internal.turns.startCompaction, { sessionId: s.turn.sessionId!, keepTokens: 1 });
		expect(JSON.stringify(compact)).toContain(SECRET);
		expect((await s.t.run((ctx) => ctx.db.get("agentSessions", s.turn.sessionId!)))!.compactingPlaces).toContain(s.deals);
		await s.t.mutation(internal.turns.finishCompaction, { sessionId: s.turn.sessionId!, result: { summary: SECRET, upTo: compact!.upTo, costUsd: 0 } });
		const crewTurn = await s.start(s.crew);
		expect(JSON.stringify(await s.t.mutation(internal.turns.turnContext, { turnId: crewTurn }))).not.toContain(SECRET);
		expect((await s.crew.query(api.chats.place, { chatId: s.chat._id }))!.summary).toBeNull();
	});

	it("steering updates prompt sources without releasing them when the answer is shared", async () => {
		const s = await setup();
		await s.t.mutation(internal.turns.savePrompt, { turnId: s.turnId, prompt: "Public question" });
		const note = await s.dana.mutation(api.messages.send, { chatId: s.chat._id, text: SECRET, mentions: noMentions });
		await s.t.run((ctx) => ctx.db.patch(note, { usedPlaces: [s.deals] }));
		expect(JSON.stringify(await s.t.mutation(internal.turns.steer, { turnId: s.turnId }))).toContain(SECRET);
		expect((await s.t.run((ctx) => ctx.db.get("agentTurns", s.turnId)))!.promptPlaces).toContain(s.deals);
		await s.finish("Checked.");
		await s.owner.mutation(api.messages.share, { messageId: s.replyId });
		const next = await s.start(s.crew);
		expect(JSON.stringify(await s.t.mutation(internal.turns.turnContext, { turnId: next }))).not.toContain(SECRET);
	});

	it("ignores old prompts and summaries with unknown prompt provenance", async () => {
		const s = await setup();
		await s.t.run((ctx) => ctx.db.patch(s.turnId, { prompt: SECRET }));
		await s.finish("Public answer.");
		await s.t.run((ctx) => ctx.db.patch(s.turn.sessionId!, { summary: SECRET, summaryPlaces: [], summarizedUpTo: Date.now() + 100 }));
		const next = await s.start(s.crew);
		const context = await s.t.mutation(internal.turns.turnContext, { turnId: next });
		expect(JSON.stringify(context)).not.toContain(SECRET);
		expect(JSON.stringify(context)).toContain("Public answer.");
		expect((await s.owner.query(api.chats.place, { chatId: s.chat._id }))!.summary).toBeNull();
	});

	it("personal skills disappear from app and agent reads after an upstream source is revoked", async () => {
		const s = await setup();
		const dm = await s.dana.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const turnId = await s.start(s.dana, dm);
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		const created = await s.t.mutation(internal.skills.createFor, { turnId, audience: "personal", config: { name: "Private procedure", description: "Private", instructions: SECRET } });
		if (!("created" in created)) throw new Error(JSON.stringify(created));
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: s.deals, access: [] });
		expect(JSON.stringify(await s.dana.query(api.skills.list))).not.toContain(SECRET);
		expect(JSON.stringify(await s.t.mutation(internal.turns.turnContext, { turnId }))).not.toContain(SECRET);
		expect(await s.t.mutation(internal.manageTools.runFor, { turnId, tool: "skills.manage", input: { request: { action: "get", id: created.created } } })).toHaveProperty("error");
	});

	it("rail record titles respect both database access and retained upstream sources", async () => {
		const s = await setup();
		expect(await s.crew.query(api.records.titles, { recordIds: [s.deal] })).toEqual([]);
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "records.edit", on: true });
		const clients = (await s.owner.query(api.recordTypes.list)).find((t) => t.key === "client")!;
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: clients._id, access: [{ role: s.office, level: "edit" }] });
		await s.read();
		const saved = await s.t.mutation(internal.recordTools.saveFor, { turnId: s.turnId, input: { type: clients.key, values: { name: SECRET } } });
		if (!("id" in saved)) throw new Error(JSON.stringify(saved));
		expect(await s.dana.query(api.records.titles, { recordIds: [saved.id] })).toHaveLength(1);
		await s.owner.mutation(api.recordTypes.setAccess, { typeId: s.deals, access: [] });
		expect(await s.dana.query(api.records.titles, { recordIds: [saved.id] })).toEqual([]);
	});

	it("discards a summary from compaction that started before prompt source isolation", async () => {
		const s = await setup();
		await s.t.run((ctx) => ctx.db.patch(s.turn.sessionId!, { compacting: true, compactingPlaces: [] }));
		await s.t.mutation(internal.turns.finishCompaction, { sessionId: s.turn.sessionId!, result: { summary: SECRET, upTo: Date.now(), costUsd: 0 } });
		const session = (await s.t.run((ctx) => ctx.db.get("agentSessions", s.turn.sessionId!)))!;
		expect(session.compacting).toBe(false);
		expect(session.summary).toBeUndefined();
		expect(session.summaryPrivacy).toBeUndefined();
		expect((await s.owner.query(api.chats.place, { chatId: s.chat._id }))!.summary).toBeNull();
	});


	it("only the asker's own DM releases personal data for chosen writes", async () => {
		const s = await setup();
		const dm = await s.owner.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const turnId = await s.start(s.owner, dm);
		const clients = (await s.owner.query(api.recordTypes.list)).find((t) => t.key === "client")!;
		const saved = await s.t.mutation(internal.recordTools.saveFor, { turnId, input: { type: clients.key, values: { name: "Acme" } } });
		expect(saved).not.toHaveProperty("error");
		await expect(s.t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: "Own DM team fact" })).resolves.toHaveProperty("id");
		expect(JSON.stringify(await s.crew.query(api.records.list, { typeId: clients._id, paginationOpts: { cursor: null, numItems: 20 } }))).toContain("Acme");
		expect(JSON.stringify(await s.crew.query(api.memory.list))).toContain("Own DM team fact");
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
		const personal = await s.dana.mutation(api.skills.create, { audience: "personal", config: { name: "My preferences", description: "Personal", instructions: SECRET } });
		await s.t.mutation(internal.turns.turnContext, { turnId: s.turnId });
		await s.t.mutation(internal.skills.loadFor, { turnId: s.turnId, id: personal });
		await expect(s.t.mutation(internal.memory.createFor, { turnId: s.turnId, scope: "workspace", content: SECRET })).rejects.toThrow("Only Dana");
		await s.finish();
		expect((await s.reply(s.dana)).privacy?.label).toBe("Only Dana can see this");
		expect(JSON.stringify(await s.reply(s.crew))).not.toContain(SECRET);
		// Another person's turn still has to respect Dana's source.
		const crewTurn = await s.start(s.crew);
		await s.t.run(async (ctx) => {
			const turn = (await ctx.db.get("agentTurns", crewTurn))!;
			await ctx.db.patch(turn.replyId!, { usedPlaces: [s.dana.userId] });
		});
		await expect(s.t.mutation(internal.memory.createFor, { turnId: crewTurn, scope: "workspace", content: SECRET })).rejects.toThrow("Only Dana");
		expect(personal).toBeTruthy();
	});

	it("sharing releases the answer but no tool input, output, label or approval reason through any reader", async () => {
		const s = await setup();
		await s.read();
		for (let i = 0; i < 3; i++) await s.t.mutation(internal.activity.log, { turnId: s.turnId, callId: `private-${i}`, tool: "records.get", changes: false, input: SECRET, output: SECRET, error: SECRET });
		const { approvalId } = await s.t.mutation(internal.approvals.request, { turnId: s.turnId, callId: "approval", tool: "chat.send", input: JSON.stringify({ text: SECRET }), risk: "outside", why: SECRET });
		await s.t.mutation(internal.turns.updateReply, { turnId: s.turnId, text: "Checked.", parts: [
			...Array.from({ length: 2 }, (_, i) => ({ type: "tool" as const, id: `private-${i}`, name: "records.get", label: SECRET, status: "done" as const })),
			{ type: "approval", id: "private-2", approvalId, tool: "chat.send", why: SECRET },
			{ type: "text", text: "Checked." },
		] });
		await s.t.mutation(internal.turns.finishReply, { turnId: s.turnId });
		expect((await s.reply(s.dana)).privacy?.share).toContain("Share just the answer?");
		await s.dana.mutation(api.messages.share, { messageId: s.replyId });
		const shown = await s.reply(s.crew);
		expect(shown.text).toBe("Checked.");
		expect(shown.parts).toContainEqual({ type: "text", text: "Used 3 tools" });
		expect(JSON.stringify(shown)).not.toContain(SECRET);
		expect(await s.crew.query(api.activity.forReply, { replyId: s.replyId })).toEqual([]);
		expect(await s.crew.query(api.approvals.forReply, { replyId: s.replyId })).toEqual([]);
		expect(JSON.stringify(await s.crew.query(api.activity.list, {}))).not.toContain(SECRET);
		expect(JSON.stringify(await s.dana.query(api.activity.forReply, { replyId: s.replyId }))).toContain(SECRET);
		const next = await s.start(s.crew);
		expect(JSON.stringify(await s.t.mutation(internal.recordTools.historyFor, { turnId: next, source: "agents" }))).not.toContain(SECRET);
		expect(JSON.stringify(await s.t.mutation(internal.turns.turnContext, { turnId: next }))).not.toContain(SECRET);
	});

	it("leaves hidden reacted-to messages out of the next turn's context", async () => {
		const s = await setup();
		await s.read();
		await s.finish();
		const previous = await s.start(s.crew);
		await s.t.mutation(internal.turns.savePrompt, { turnId: previous, prompt: "Public question" });
		await s.t.mutation(internal.turns.finishReply, { turnId: previous });
		vi.setSystemTime(Date.now() + 1000);
		await s.dana.mutation(api.messages.react, { messageId: s.replyId, emoji: "👍" });
		const next = await s.start(s.crew);
		const context = await s.t.mutation(internal.turns.turnContext, { turnId: next });
		expect(context.reacted).toEqual([]);
		expect(JSON.stringify(context)).not.toContain(SECRET);
	});

	it("rejects hidden emoji tags while allowing the three real subdivision flags", async () => {
		const s = await setup();
		const messageId = await s.owner.mutation(api.messages.send, { chatId: s.chat._id, text: "Public note", mentions: noMentions });
		const flag = (tag: string) => "🏴" + [...tag].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("") + "\u{e007f}";
		await expect(s.owner.mutation(api.messages.react, { messageId, emoji: flag("secret") })).rejects.toThrow("Pick one emoji");
		for (const tag of ["gbeng", "gbsct", "gbwls"]) await expect(s.owner.mutation(api.messages.react, { messageId, emoji: flag(tag) })).resolves.toBe(true);
	});

	it.each(["private", "restricted"] as const)("origin fallback includes a %s chat before context has loaded", async (kind) => {
		const s = await setup();
		const chatId = await s.owner.mutation(api.chats.createChannel, { name: "origin-only", private: kind === "private" });
		if (kind === "restricted") await s.owner.mutation(api.chats.setAccess, { chatId, access: [] });
		const turnId = await s.start(s.owner, chatId);
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		expect((await s.t.run((ctx) => ctx.db.get(replyId)))!.usedPlaces ?? []).toEqual([]);
		await s.t.run(async (ctx) => {
			const member = (await memberOf(ctx, s.owner.userId, s.turn.workspaceId))!;
			member.replyId = replyId;
			expect(await turnSources(ctx, member)).toContain(chatId);
			await expect(writeSources(ctx, member)).rejects.toThrow("wider audience");
		});
	});

	it.each(["group DM", "private channel", "role-limited channel"] as const)("the own-data exception does not open a %s", async (kind) => {
		const s = await setup();
		const chatId = kind === "group DM"
			? await s.owner.mutation(api.chats.openDm, { userIds: [s.crew.userId], agentIds: [s.companybot._id] })
			: await s.owner.mutation(api.chats.createChannel, { name: "restricted-origin", private: kind === "private channel" });
		if (kind === "role-limited channel") await s.owner.mutation(api.chats.setAccess, { chatId, access: [] });
		const turnId = await s.start(s.owner, chatId);
		await expect(s.t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: SECRET })).rejects.toThrow("wider audience");
	});

});


describe("central write audience review probes", () => {
	const SECRET = "Vault margin 42%";
	let network: ReturnType<typeof vi.spyOn>;
	beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled during review")); });
	afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

	async function probeSetup() {
		const { t, owner, member: crew } = await ownerAndMember();
		const general = await generalOf(owner);
		const { companybot } = await agentsOf(owner);
		const start = (chatId = general._id) => agentTurn(t, owner, chatId, companybot._id);
		const privateTurn = async () => {
			const ops = await owner.mutation(api.chats.createChannel, { name: "ops", private: true });
			await owner.mutation(api.messages.send, { chatId: ops, text: SECRET, mentions: noMentions });
			const turnId = await start(ops);
			await t.mutation(internal.turns.turnContext, { turnId });
			return { ops, turnId };
		};
		const restrict = async () => {
			const type = (await owner.query(api.recordTypes.list)).find((t) => t.key === "deal")!;
			const secret = await owner.mutation(api.records.create, { typeId: type._id, values: { name: SECRET } });
			await owner.mutation(api.recordTypes.setAccess, { typeId: type._id, access: [] });
			const turnId = await start();
			await t.mutation(internal.recordTools.getFor, { turnId, id: secret });
			return { type, turnId };
		};
		return { t, owner, crew, general, companybot, start, privateTurn, restrict };
	}

	it("private-origin text must not reach a shared workspace name", async () => {
		const s = await probeSetup();
		const { turnId } = await s.privateTurn();
		const result = await s.t.mutation(internal.manageTools.runFor, { turnId, tool: "workspace.settings", input: { request: { action: "update", name: SECRET, expectedVersion: (await s.owner.query(api.workspace.settings))!.version } } });
		expect(result).toHaveProperty("error");
		expect((await s.crew.query(api.workspace.me))!.workspace).not.toBe(SECRET);
	});

	it("a restricted turn's decision cannot react on a wider public message", async () => {
		const s = await probeSetup();
		const { turnId } = await s.restrict();
		const target = await s.owner.mutation(api.messages.send, { chatId: s.general._id, text: "Public note", mentions: noMentions });
		const turn = await decideReaction(s.t, turnId, target, "✅");
		expect(turn.status).toBe("error");
		expect((await s.t.run((ctx) => ctx.db.get(turn.replyId!)))!.error).toContain("Only Owners");
		expect(await s.t.run((ctx) => ctx.db.query("reactions").collect())).toEqual([]);
	});

	it("private automation must retain source taint across turns before publishing", async () => {
		const s = await probeSetup();
		const { turnId, type } = await s.restrict();
		await s.t.run(async (ctx) => { const a = (await ctx.db.get(s.companybot._id))!; await ctx.db.patch(a._id, { tools: [...new Set([...a.tools, "automations.manage"])] }); });
		const created = await s.t.mutation(internal.automationTools.createFor, { turnId, input: { name: "My digest", prompt: SECRET, trigger: { type: "schedule", cron: "0 9 * * *" }, runsFor: "me" } });
		if (!("created" in created)) throw new Error(JSON.stringify(created));
		await s.t.mutation(internal.turns.finishReply, { turnId });
		// Stored provenance guards publication even without first reading it in another turn.
		await expect(s.owner.mutation(api.automations.update, { automationId: created.created, audience: "subscribers" })).rejects.toThrow("Only Owners");
		const other = await s.owner.mutation(api.chats.createChannel, { name: "separate", private: false });
		const next = await s.start(other);
		const read = await s.t.mutation(internal.manageTools.runFor, { turnId: next, tool: "automations.manage", input: { request: { action: "get", id: created.created } } });
		expect(JSON.stringify(read)).toContain(SECRET);
		const reply = (await s.t.run((ctx) => ctx.db.get("agentTurns", next)))!.replyId!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", reply)))!.usedPlaces).toContain(type._id);
		const result = await s.t.mutation(internal.manageTools.runFor, { turnId: next, tool: "automations.manage", input: { request: { action: "set_audience", id: created.created, audience: "subscribers" } } });
		expect(result).toHaveProperty("error");
		expect(JSON.stringify(await s.crew.query(api.automations.list))).not.toContain(SECRET);
	});

	it("private-channel automation deliveries must retain the original source after revocation", async () => {
		const s = await probeSetup();
		const ops = await s.owner.mutation(api.chats.createChannel, { name: "ops", private: true });
		await s.owner.mutation(api.automations.create, { config: { name: "Watch ops", prompt: "Summarize", trigger: { type: "event", event: "message.posted", channelId: ops } }, agentId: s.companybot._id, audience: "creator", timeZone: "UTC" });
		await s.owner.mutation(api.messages.send, { chatId: ops, text: SECRET, mentions: noMentions });
		const turn = (await s.t.run((ctx) => ctx.db.query("agentTurns").collect())).find((t) => t.chatId !== ops)!;
		expect(turn).toBeDefined();
		expect(JSON.stringify(await s.t.mutation(internal.turns.turnContext, { turnId: turn._id }))).toContain(SECRET);
		await s.t.mutation(internal.turns.updateReply, { turnId: turn._id, text: SECRET, parts: [{ type: "text", text: SECRET }] });
		await s.t.mutation(internal.turns.finishReply, { turnId: turn._id });
		await s.t.run(async (ctx) => { for (const m of await ctx.db.query("chatMembers").collect()) if (m.chatId === ops && m.userId === s.owner.userId) await ctx.db.delete(m._id); });
		expect(await s.owner.query(api.chats.get, { chatId: ops })).toBeNull();
		const delivered = await s.owner.query(api.messages.list, { chatId: turn.chatId });
		expect(delivered.find((m) => m._id === turn.replyId)!.text).not.toContain(SECRET);
		expect(JSON.stringify(delivered)).not.toContain(SECRET);
	});

	it.each(["record", "page", "team memory"])("private-origin text must not reach public %s content", async (kind) => {
		const s = await probeSetup();
		const clients = (await s.owner.query(api.recordTypes.list)).find((t) => t.key === "client")!;
		const page = await s.owner.mutation(api.pages.create, { title: "Public page" });
		const { turnId } = await s.privateTurn();
		if (kind === "record") {
			const result = await s.t.mutation(internal.recordTools.saveFor, { turnId, input: { type: clients.key, values: { name: SECRET } } });
			expect(result).toHaveProperty("error");
			expect(JSON.stringify(await s.crew.query(api.records.list, { typeId: clients._id, paginationOpts: { numItems: 20, cursor: null } }))).not.toContain(SECRET);
		} else if (kind === "page") {
			const blocks = JSON.stringify([{ type: "blockContainer", attrs: { id: "leak" }, content: [{ type: "paragraph", content: [{ type: "text", text: SECRET }] }] }]);
			const result = await s.t.mutation(internal.pageTools.writeFor, { turnId, input: { page, blocks, mode: "replace" } });
			expect(result).toHaveProperty("error");
			expect(JSON.stringify(await identityOf(s.t, s.crew.userId).query(api.pageSync.getSnapshot, { id: page }))).not.toContain(SECRET);
		} else {
			await expect(s.t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: SECRET })).rejects.toThrow("people in #ops");
			expect(JSON.stringify(await s.crew.query(api.memory.list))).not.toContain(SECRET);
		}
	});
	it("requires one real emoji and checks the decision reaction's actual readers", async () => {
		const s = await probeSetup();
		const { turnId } = await s.restrict();
		const privateReply = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
		expect((await decideReaction(s.t, turnId, privateReply, "👍")).status).toBe("done");
		const target = await s.owner.mutation(api.messages.send, { chatId: s.general._id, text: "Public note", mentions: noMentions });
		for (const emoji of ["secret", "a", "1", "👍👍", "👍a", "🇺", "👍\u200d"]) {
			await expect(s.owner.mutation(api.messages.react, { messageId: target, emoji })).rejects.toThrow("Pick one emoji");
		}
		for (const emoji of ["👍🏽", "👩‍💻", "🇺🇸", "1️⃣", "❤️", "👨‍👩‍👧‍👦"]) await expect(s.owner.mutation(api.messages.react, { messageId: target, emoji })).resolves.toBeDefined();
		const publicTurn = await s.start();
		expect((await decideReaction(s.t, publicTurn, target, "👍")).status).toBe("done");
		expect((await s.crew.query(api.messages.list, { chatId: s.general._id })).find((m) => m._id === target)!.reactions).toContainEqual(expect.objectContaining({ emoji: "👍", count: 1 }));
	});

	it("private memory carries its sources into another turn and disappears after revocation", async () => {
		const s = await probeSetup();
		const { ops, turnId } = await s.privateTurn();
		const memory = await s.t.mutation(internal.memory.createFor, { turnId, scope: "personal", content: SECRET });
		expect((await s.t.run((ctx) => ctx.db.get("memories", memory.id as Id<"memories">)))!.usedPlaces).toContain(ops);
		await s.t.mutation(internal.turns.finishReply, { turnId });
		const dm = await s.owner.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const next = await s.start(dm);
		expect(JSON.stringify(await s.t.mutation(internal.memory.searchFor, { turnId: next, query: "Vault" }))).toContain(SECRET);
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", next)))!.replyId!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces).toContain(ops);
		await s.t.run(async (ctx) => { for (const m of await ctx.db.query("chatMembers").collect()) if (m.chatId === ops && m.userId === s.owner.userId) await ctx.db.delete(m._id); });
		expect(JSON.stringify(await s.owner.query(api.memory.list))).not.toContain(SECRET);
		expect(await s.t.mutation(internal.memory.searchFor, { turnId: next, query: "Vault" })).toEqual([]);
	});

	it("private automations keep provenance when edited and run, and hide after revocation", async () => {
		const s = await probeSetup();
		const { ops, turnId } = await s.privateTurn();
		const created = await s.t.mutation(internal.automationTools.createFor, { turnId, input: { name: "Private digest", prompt: SECRET, trigger: { type: "schedule", cron: "0 9 * * *" }, runsFor: "me" } });
		if (!("created" in created)) throw new Error(JSON.stringify(created));
		await s.owner.mutation(api.automations.save, { automationId: created.created, expectedVersion: 1, config: { name: "Revised", prompt: SECRET, trigger: { type: "schedule", cron: "0 10 * * *" } } });
		await expect(s.owner.mutation(api.automations.update, { automationId: created.created, audience: "channel", channelId: s.general._id })).rejects.toThrow("people in #ops");
		await s.owner.mutation(api.automationRuns.runNow, { automationId: created.created });
		const run = (await s.t.run((ctx) => ctx.db.query("agentTurns").collect())).find((t) => t.chatId !== ops)!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", run.triggerId!)))!.usedPlaces).toContain(s.owner.userId);
		expect(JSON.stringify(await s.t.mutation(internal.turns.turnContext, { turnId: run._id }))).toContain(SECRET);
		expect((await s.t.run((ctx) => ctx.db.get(run.replyId!)))!.usedPlaces).toContain(ops);
		await s.t.run(async (ctx) => { for (const m of await ctx.db.query("chatMembers").collect()) if (m.chatId === ops && m.userId === s.owner.userId) await ctx.db.delete(m._id); });
		expect(JSON.stringify(await s.owner.query(api.automations.list))).not.toContain(SECRET);
		await expect(s.owner.mutation(api.automationRuns.runNow, { automationId: created.created })).rejects.toThrow("Automation not found");
	});

});

const cancelScheduled = (t: Awaited<ReturnType<typeof ownerAndMember>>["t"]) =>
	t.run(async (ctx) => { for (const job of await ctx.db.system.query("_scheduled_functions").collect()) if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id); });

describe("own-data authority and chat-file provenance", () => {
	let network: ReturnType<typeof vi.spyOn>;
	beforeEach(() => { network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled during security regression")); });
	afterEach(() => { expect(network).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
	it("a foreign subscriber automation with Always cannot publish the runner's personal connector data", async () => {
		const { t, owner, member: ben } = await ownerAndMember();
		await setMemberSwitch(owner, "automations.edit", true);
		const { companybot } = await agentsOf(owner);
		await owner.mutation(api.connectors.setInstalled, { connectorId: "notes", installed: true });
		await owner.action(api.connectors.connect, { connectorId: "notes", credentials: { type: "api_key", key: "local-fixture" } });
		const general = await generalOf(owner);
		const daily = { name: "Daily summary", prompt: "Summarize sales.", trigger: { type: "schedule" as const, cron: "0 9 * * *" } };
		const id = await ben.mutation(api.automations.create, { config: daily, agentId: companybot._id, audience: "subscribers", timeZone: "UTC" });
		await owner.mutation(api.automations.subscribe, { automationId: id, on: true });
		const run = async () => {
			await t.run(async (ctx) => { const i = (await ctx.db.query("automationInstalls").collect()).find((x) => x.automationId === id)!; await ctx.db.patch(i._id, { lastScheduledAt: 0 }); });
			for (const turn of await turnsOf(t)) if (turn.status === "running" || turn.status === "queued") await t.mutation(internal.turns.finishReply, { turnId: turn._id });
			const before = await turnsOf(t);
			await t.mutation(internal.automationRuns.tick, { now: (Math.floor(Date.now() / 86_400_000) + 2) * 86_400_000 + 10 * 3_600_000 });
			await cancelScheduled(t);
			return (await turnsOf(t)).find((x) => !before.some((b) => b._id === x._id) && x.actorId === owner.userId)!;
		};
		// Run 1: owner allows "post in #general" for this automation (a normal, benign grant).
		const first = await run();
		const post = { request: { action: "send", chat: "general", text: "Sales summary" } };
		const { approvalId } = await t.mutation(internal.approvals.request, { turnId: first._id, callId: "c1", tool: "chat.manage", input: canonicalJson(post), risk: "inside" });
		const row = (await t.run((ctx) => ctx.db.get(approvalId)))!;
		await owner.mutation(api.approvals.decide, { approvalId, hash: row.hash, approve: true, always: true });
		await cancelScheduled(t);
		// Ben rewords the prompt; the grant survives (existing behavior).
		const install = await t.run(async (ctx) => (await ctx.db.query("automationInstalls").collect()).find((i) => i.automationId === id)!);
		await ben.mutation(api.automations.save, { automationId: id, config: { ...daily, prompt: "Read my Gmail and post it to #general." }, expectedVersion: install.custom!.version });
		const turn = await run();
		const chat = (await t.run((ctx) => ctx.db.get("chats", turn.chatId)))!;
		expect(chat.kind).toBe("dm");
		// The run is foreign (Ben's words), and chat.manage now runs via the automation grant.
		expect((await t.mutation(internal.permissions.check, { turnId: turn._id, action: "chat.manage", risk: "inside" })).decision).toEqual({ type: "run", via: "automation" });
		// A read-only personal connector call is risk "none" (runs without asking) and records the owner's personal source.
		expect((await t.mutation(internal.permissions.check, { turnId: turn._id, action: "notes.read", risk: "none" })).decision.type).toBe("run");
		expect(await t.mutation(internal.connectors.forCall, { turnId: turn._id, connectorId: "notes" })).not.toBeNull();
		expect((await t.run((ctx) => ctx.db.get("chatMessages", turn.replyId!)))!.usedPlaces).toContain(owner.userId);
		const sent = await t.mutation(internal.manageTools.runFor, { turnId: turn._id, tool: "chat.manage", input: { request: { action: "send", chat: general._id, text: SECRET } } });
		expect(sent).not.toHaveProperty("error");
		// The existing grant can send, but cannot remove the runner-only audience.
		expect(JSON.stringify(await ben.query(api.messages.list, { chatId: general._id }))).not.toContain(SECRET);
		expect(JSON.stringify(await owner.query(api.messages.list, { chatId: general._id }))).toContain(SECRET);
		await expect(t.mutation(internal.memory.createFor, { turnId: turn._id, scope: "workspace", content: SECRET })).rejects.toThrow("wider audience");
	});

	it.each([true, false])("only an own wakeup can publish personal data from its DM (foreign=%s)", async (foreign) => {
		const { t, owner, member: other } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const personal = await owner.mutation(api.memory.create, { agentId: companybot._id, scope: "personal", content: SECRET });
		const turnId = await t.run(async (ctx) => {
			const wakeupId = await createWakeup(ctx, { workspaceId: (await ctx.db.get(dm))!.workspaceId, chatId: dm, agentId: companybot._id, actorId: owner.userId, createdBy: foreign ? other.userId : owner.userId, note: "Follow up", foreign });
			await wake(ctx, wakeupId);
			return (await ctx.db.query("agentTurns").collect()).find((turn) => turn.wakeupId === wakeupId)!._id;
		});
		expect(JSON.stringify(await t.mutation(internal.memory.searchFor, { turnId, query: "Quartz" }))).toContain(SECRET);
		const write = () => t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: SECRET });
		if (foreign) {
			await expect(write()).rejects.toThrow("wider audience");
			expect(JSON.stringify(await other.query(api.memory.list))).not.toContain(SECRET);
		} else await expect(write()).resolves.toHaveProperty("id");
		expect(personal).toBeTruthy();
	});

	it("an own turn in a public channel cannot publish a personal-memory read as team memory", async () => {
		const s = await setup();
		const id = await s.dana.mutation(api.memory.create, { agentId: s.companybot._id, scope: "personal", content: SECRET });
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
		// Exercise the common reader even though automatic personal-memory search is DM-only.
		await s.t.run(async (ctx) => {
			const { member } = await runningTurn(ctx, s.turnId);
			const memory = (await ctx.db.get("memories", id.id as Id<"memories">))!;
			expect(await readArtifact(ctx, member, memory, memory.ownerId)).toBe(true);
		});
		await expect(s.t.mutation(internal.memory.createFor, { turnId: s.turnId, scope: "workspace", content: SECRET })).rejects.toThrow("Only Dana");
		expect(JSON.stringify(await s.crew.query(api.memory.list))).not.toContain(SECRET);
	});

	it.each(["private", "restricted"] as const)("reading or copying a file from a %s chat records its chat before returning", async (kind) => {
		const s = await setup();
		const chatId = await s.owner.mutation(api.chats.createChannel, { name: "file-source", private: kind === "private" });
		if (kind === "private") await s.owner.mutation(api.chats.addMembers, { chatId, userIds: [s.dana.userId], agentIds: [] });
		else await s.owner.mutation(api.chats.setAccess, { chatId, access: [{ role: s.office, level: "view" }] });
		const messageId = await s.t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob([SECRET], { type: "text/plain" }));
			return ctx.db.insert("chatMessages", { workspaceId: s.turn.workspaceId, chatId, authorUserId: s.owner.userId, text: "File", parts: [], status: "done", mentions: noMentions, attachments: [{ storageId, name: "secret.txt", type: "text/plain", size: SECRET.length }] });
		});
		expect(await s.t.mutation(internal.files.readFor, { turnId: s.turnId, id: `${messageId}/0` })).toHaveProperty("name", "secret.txt");
		expect((await s.t.run((ctx) => ctx.db.get(s.replyId)))!.usedPlaces).toContain(chatId);
		await s.t.run((ctx) => ctx.db.patch(s.replyId, { usedPlaces: [] }));
		const copied = await s.t.action(internal.files.copyFor, { turnId: s.turnId, ids: [`${messageId}/0`], picture: false });
		expect(copied).toHaveProperty("copies");
		expect((await s.t.run((ctx) => ctx.db.get(s.replyId)))!.usedPlaces).toContain(chatId);
	});

	it.each(["page", "record"] as const)("a private chat picture cannot be copied into a public %s, even without a body change", async (kind) => {
		const s = await setup();
		const page = await s.owner.mutation(api.pages.create, { title: "Public document" });
		const clients = (await s.owner.query(api.recordTypes.list)).find((type) => type.key === "client")!._id;
		const record = await s.owner.mutation(api.records.create, { typeId: clients, values: { name: "Public client" } });
		const privateChat = await s.owner.mutation(api.chats.createChannel, { name: "picture-source", private: true });
		const messageId = await s.t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(["private picture"], { type: "image/png" }));
			return ctx.db.insert("chatMessages", { workspaceId: s.turn.workspaceId, chatId: privateChat, authorUserId: s.owner.userId, text: "Private image", parts: [], status: "done", mentions: noMentions, attachments: [{ storageId, name: "private.png", type: "image/png", size: 15 }] });
		});
		await s.finish("Done.");
		const turnId = await s.start(s.owner);
		const copied = await s.t.action(internal.files.copyFor, { turnId, ids: [`${messageId}/0`], picture: true });
		if (!("copies" in copied)) throw new Error(copied.error);
		const storageId = copied.copies[`${messageId}/0`]!;
		const url = (await s.t.run((ctx) => ctx.storage.getUrl(storageId)))!;
		const result = await s.t.mutation(internal.pageTools.writeFor, { turnId, input: kind === "page" ? { page } : { record }, pictures: [{ storageId, url }] });
		expect(result).toHaveProperty("error", expect.stringContaining("wider audience"));
		expect(await s.t.run((ctx) => ctx.db.query("pageImages").collect())).toEqual([]);
		expect(await s.t.run(async (ctx) => (await ctx.db.query("uploads").collect()).some((upload) => upload.storageId === storageId))).toBe(true);
	});
	it.each(["workspace", "me", "agent"] as const)("a restricted file cannot become a shared %s picture", async (of) => {
		const s = await setup();
		const dm = await s.owner.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const turnId = await s.start(s.owner, dm);
		await s.t.mutation(internal.recordTools.getFor, { turnId, id: s.deal });
		const storageId = await s.t.run(async (ctx) => {
			const storageId = await ctx.storage.store(new Blob(["private picture"], { type: "image/png" }));
			await ctx.db.insert("uploads", { storageId, userId: s.owner.userId, workspaceId: s.turn.workspaceId, createdAt: Date.now() });
			return storageId;
		});
		const request = of === "agent" ? { action: "set_image", id: s.companybot._id, file: "copied-image" } : { action: "set_image", of, file: "copied-image" };
		const result = await s.t.mutation(internal.manageTools.runFor, { turnId, tool: of === "agent" ? "agents.manage" : "workspace.settings", input: { request }, uploads: { "copied-image": storageId } });
		expect(result).toHaveProperty("error", expect.stringContaining("wider audience"));
		expect(await s.t.run(async (ctx) => (await ctx.db.query("uploads").collect()).some((upload) => upload.storageId === storageId))).toBe(true);
	});

});
