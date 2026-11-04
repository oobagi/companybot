import { approxTokens } from "@companybot/core";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { createField, createRecord, createType, updateField, updateRecord, updateType } from "../convex/recordOps";
import { createPage, renamePage, writeBlocks } from "../convex/pageOps";
import { saveView } from "../convex/databaseViews";
import { type Who, memberOf } from "../convex/lib";
import { canReadReply } from "../convex/replyPrivacy";
import { KEEP_TOKENS } from "../convex/turns";
import { agentsOf, agentTurn, generalOf, noMentions, ownerAndMember, signIn, type As } from "./helpers";

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
		expect(visible.privacy).toMatchObject({ hidden: false, label: "Only Office and Owners can see this", why: "Uses the Deals database", share: "Not everyone in #general can see Deals. Share anyway?" });
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
		const s = await setup(); await s.read();
		await expect(s.t.mutation(internal.memory.createFor, { turnId: s.turnId, scope: "workspace", content: SECRET })).rejects.toThrow("personal memory");
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
		await s.t.mutation(internal.wakeups.createFor, { turnId: s.turnId, input: { note: SECRET, in: "1 hour" } });
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
				await ctx.db.insert("agentTurns", { workspaceId: s.turn.workspaceId, chatId: s.chat._id, agentId: s.companybot._id, actorId: s.crew.userId, sessionId: s.turn.sessionId!, replyId, prompt: `Readable request ${i}: ` + "x".repeat(2000), status: "done" });
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

	it.each(["private", "restricted"] as const)("does not treat its own %s channel as a source or block team memory there", async (kind) => {
		const s = await setup();
		const room = await s.owner.mutation(api.chats.createChannel, { name: "ops", private: kind === "private" });
		if (kind === "private") await s.owner.mutation(api.chats.addMembers, { chatId: room, userIds: [s.dana.userId], agentIds: [] });
		if (kind === "restricted") await s.owner.mutation(api.chats.setAccess, { chatId: room, access: [{ role: s.office, level: "edit" }] });
		await s.owner.mutation(api.roles.setPermission, { id: s.office, permission: "memory.team.write", on: true });
		const turnId = await s.start(s.dana, room);
		await s.t.mutation(internal.turns.turnContext, { turnId });
		const turn = (await s.t.run((ctx) => ctx.db.get("agentTurns", turnId)))!;
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", turn.replyId!)))!.usedPlaces ?? []).toEqual([]);
		expect((await s.dana.query(api.messages.list, { chatId: room })).find((m) => m._id === turn.replyId)!.privacy).toBeNull();
		await expect(s.t.mutation(internal.memory.createFor, { turnId, scope: "workspace", content: "The team meets every Monday." })).resolves.toHaveProperty("id");
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
		await s.t.mutation(internal.wakeups.createFor, { turnId: s.turnId, input: { note: "Old follow-up", in: "1 hour" } });
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
		expect(await s.t.mutation(internal.skills.createFor, { turnId, config: { ...safe, instructions: SECRET } })).toHaveProperty("error", expect.stringContaining("restricted places"));
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
		expect((await s.t.run((ctx) => ctx.db.get("chatMessages", replyId)))!.usedPlaces ?? []).not.toContain(ops);
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

});
