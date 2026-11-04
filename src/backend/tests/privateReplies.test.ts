import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { fireEvent } from "../convex/automationRuns";
import { agentsOf, agentTurn, generalOf, noMentions, ownerAndMember, signIn, type As } from "./helpers";

const SECRET = "Quartz contract: $91,000, margin 42%";
const PAGE = { paginationOpts: { cursor: null, numItems: 20 } };
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
	const finish = async () => { await write(); await t.mutation(internal.turns.finishReply, { turnId }); };
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

	it("keeps one-person DMs familiar and protects group DMs and side chats", async () => {
		const s = await setup(); await s.finish();
		const dm = await s.dana.mutation(api.chats.openDm, { userIds: [], agentIds: [s.companybot._id] });
		const id = await s.start(s.dana, dm);
		await s.t.mutation(internal.recordTools.getFor, { turnId: id, id: s.deal });
		const replyId = (await s.t.run((ctx) => ctx.db.get("agentTurns", id)))!.replyId!;
		expect((await s.dana.query(api.messages.list, { chatId: dm })).find((m) => m._id === replyId)!.privacy).toBeNull();
		const group = await s.dana.mutation(api.chats.openDm, { userIds: [s.crew.userId], agentIds: [s.companybot._id] });
		const groupTurn = await s.start(s.dana, group);
		await s.t.mutation(internal.recordTools.getFor, { turnId: groupTurn, id: s.deal });
		await s.t.mutation(internal.turns.updateReply, { turnId: groupTurn, text: SECRET, parts: [{ type: "text", text: SECRET }] });
		await s.t.mutation(internal.turns.finishReply, { turnId: groupTurn });
		expect(JSON.stringify(await s.crew.query(api.messages.list, { chatId: group }))).not.toContain(SECRET);
		expect(JSON.stringify(await s.crew.query(api.chats.alerts))).not.toContain(SECRET);
	});

	it("sweeps chat-reading queries and tools as Crew: no secret in search, previews, alerts, Activity or context", async () => {
		const s = await setup(); await s.read(); await s.finish();
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
		expect(JSON.stringify(seen)).not.toContain(SECRET);
	});

	it("does not deliver a hidden message.posted payload to automations", async () => {
		const s = await setup(); await s.read(); await s.finish();
		await s.owner.mutation(api.automations.create, { config: { name: "Digest", prompt: "Summarize", trigger: { type: "event", event: "message.posted", channelId: s.chat._id } }, agentId: s.companybot._id, audience: "subscribers", timeZone: "UTC" });
		await s.t.run((ctx) => fireEvent(ctx, s.turn.workspaceId, "message.posted", { channelId: s.chat._id, messageId: s.replyId, data: { text: SECRET } }));
		expect(JSON.stringify(await s.t.run((ctx) => ctx.db.query("chatMessages").collect()))).not.toContain('"automation":');
	});
});
