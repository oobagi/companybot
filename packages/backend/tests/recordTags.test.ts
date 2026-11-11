import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { type As, agentTurn, agentsOf, finishTurn, generalOf, messagesIn, noMentions, ownerAndMember } from "./helpers";

// Records tagged in chat messages (core record-mentions.ts, backend recordTags.ts): people and agents write
// `[@Name](record:id)`, the server keeps the id alone and each reader reads the name they may see.

afterEach(() => void vi.useRealTimers());

async function setup() {
	const { t, owner, member } = await ownerAndMember();
	const types = await owner.query(api.recordTypes.list);
	const clients = types.find((x) => x.key === "client")!._id;
	const deals = types.find((x) => x.key === "deal")!._id;
	// Deals: Owners only.
	await owner.mutation(api.recordTypes.setAccess, { typeId: deals, access: [] });
	const acme = await owner.mutation(api.records.create, { typeId: clients, values: { name: "Acme Roofing" } });
	const secret = await owner.mutation(api.records.create, { typeId: deals, values: { name: "Secret Merger" } });
	const general = (await generalOf(owner))._id;
	const send = (as: As, text: string, chatId = general) => as.mutation(api.messages.send, { chatId, text, mentions: noMentions });
	const last = async (as: As, chatId = general) => (await messagesIn(as, { chatId })).at(-1)!;
	const stored = (id: Id<"chatMessages">) => t.run(async (ctx) => (await ctx.db.get(id))!);
	const mentionsOf = (recordId: Id<"records">) => t.run((ctx) => ctx.db.query("recordMentions").withIndex("by_record", (q) => q.eq("recordId", recordId)).collect());
	return { t, owner, member, clients, deals, acme, secret, general, send, last, stored, mentionsOf };
}

describe("record tags in people's messages", () => {
	it("keeps the id alone, shows the live name, and lists the message on the record", async () => {
		const { owner, member, acme, send, last, stored, mentionsOf } = await setup();
		const id = await send(owner, `Signed [@Acme Roofing](record:${acme}) today`);
		expect((await stored(id)).text).toBe(`Signed <record:${acme}> today`);
		expect((await stored(id)).mentions.recordIds).toEqual([acme]);
		const shown = await last(member);
		expect(shown.text).toBe("Signed @Acme Roofing today");
		expect(shown.records).toEqual([{ text: "@Acme Roofing", id: acme, typeKey: expect.any(String), state: "live" }]);
		expect(await mentionsOf(acme)).toHaveLength(1);
		expect((await member.query(api.records.discussion, { recordId: acme })).map((m) => [m.text, m.where])).toEqual([["Signed @Acme Roofing today", "#general"]]);

		// Renamed: every message reads the new name.
		await owner.mutation(api.records.update, { recordId: acme, values: { name: "Acme West" } });
		expect((await last(member)).text).toBe("Signed @Acme West today");
	});

	it("never shows a record's name to someone who can't see its database", async () => {
		const { owner, member, secret, send, last, stored } = await setup();
		const id = await send(owner, `Talking about [@Secret Merger](record:${secret})`);
		// Not stored, so no place that reads the text can give it away.
		expect((await stored(id)).text).not.toContain("Secret");
		expect((await last(owner)).text).toBe("Talking about @Secret Merger");
		const theirs = await last(member);
		expect(theirs.text).toBe("Talking about @Private record");
		expect(theirs.records).toEqual([{ text: "@Private record", id: null, typeKey: null, state: "locked" }]);
		expect(await member.query(api.records.discussion, { recordId: secret })).toEqual([]);
		expect((await member.query(api.chats.alerts))!.map((a) => a.text).join()).not.toContain("Secret");
	});

	it("leaves tags of records the writer can't see, or made up, as the names they wrote", async () => {
		const { member, secret, send, stored, mentionsOf } = await setup();
		const id = await send(member, `Is [@Big Deal](record:${secret}) real? And [@Nope](record:abc123)?`);
		expect((await stored(id)).text).toBe("Is Big Deal real? And Nope?");
		expect((await stored(id)).mentions.recordIds).toBeUndefined();
		expect(await mentionsOf(secret)).toEqual([]);
	});

	it("reads archived and deleted records muted", async () => {
		const { t, owner, acme, clients, send, last } = await setup();
		const gone = await owner.mutation(api.records.create, { typeId: clients, values: { name: "Gone Co" } });
		await send(owner, `[@Acme](record:${acme}) and [@Gone](record:${gone})`);
		await owner.mutation(api.trash.move, { kind: "record", id: acme });
		await t.run((ctx) => ctx.db.delete(gone));
		const shown = await last(owner);
		expect(shown.text).toBe("@Acme Roofing and @Deleted record");
		expect(shown.records.map((r) => r.state)).toEqual(["archived", "deleted"]);
	});

	it("keeps tags in step with an edit", async () => {
		const { owner, acme, clients, send, stored, mentionsOf } = await setup();
		const bolt = await owner.mutation(api.records.create, { typeId: clients, values: { name: "Bolt Electric" } });
		const id = await send(owner, `Call [@Acme Roofing](record:${acme}) and [@Bolt Electric](record:${bolt})`);
		// The edit box holds the text as read: what still reads "@Acme Roofing" stays tagged; Bolt was taken out.
		await owner.mutation(api.messages.edit, { messageId: id, text: "Call @Acme Roofing tomorrow" });
		expect((await stored(id)).text).toBe(`Call <record:${acme}> tomorrow`);
		expect((await mentionsOf(acme)).length).toBe(1);
		expect(await mentionsOf(bolt)).toEqual([]);
		// A tag as written (an agent editing for its person) is added.
		await owner.mutation(api.messages.edit, { messageId: id, text: `Call @Acme Roofing and [@Bolt](record:${bolt})` });
		expect((await stored(id)).mentions.recordIds).toEqual([acme, bolt]);
		expect(await mentionsOf(bolt)).toHaveLength(1);
		// Deleting the message deletes its mentions.
		await owner.mutation(api.messages.remove, { messageId: id });
		expect(await mentionsOf(acme)).toEqual([]);
	});

	it("an edit by someone who lost sight of a tagged record keeps it, still unnamed for them", async () => {
		const { owner, member, deals, secret, send, stored, last } = await setup();
		await owner.mutation(api.recordTypes.setAccess, { typeId: deals, access: [{ role: "everyone", level: "view" }] });
		const id = await send(member, `About [@Secret Merger](record:${secret})`);
		await owner.mutation(api.recordTypes.setAccess, { typeId: deals, access: [] });
		expect((await last(member)).text).toBe("About @Private record");
		await member.mutation(api.messages.edit, { messageId: id, text: "About @Private record, again" });
		expect((await stored(id)).text).toBe(`About <record:${secret}>, again`);
		expect((await last(owner)).text).toBe("About @Secret Merger, again");
	});
});

describe("record search for the @ menu", () => {
	it("searches across the databases you can see, a few at a time", async () => {
		const { owner, member, clients, deals } = await setup();
		await owner.mutation(api.records.create, { typeId: deals, values: { name: "Acme upsell" } });
		await owner.mutation(api.records.create, { typeId: clients, values: { name: "Bolt" } });
		expect((await owner.query(api.records.mentionable, { query: "acme" })).map((r) => [r.title, r.typeName]).sort()).toEqual([["Acme Roofing", "Clients"], ["Acme upsell", "Deals"]]);
		expect((await member.query(api.records.mentionable, { query: "acme" })).map((r) => r.title)).toEqual(["Acme Roofing"]);
		expect(await member.query(api.records.mentionable, { query: " " })).toEqual([]);
	});
});

describe("record tags in agents' replies", () => {
	it("links the records its person can see; the rest stay as written", async () => {
		const { t, member, acme, secret, general, last, stored, mentionsOf } = await setup();
		const { companybot } = await agentsOf(member);
		const turnId = await agentTurn(t, member, general, companybot._id);
		vi.useRealTimers();
		await finishTurn(t, turnId, `I added [@Acme Roofing](record:${acme}) to Clients. [@Secret Merger](record:${secret}) is not mine to share.`);
		const reply = await last(member);
		expect(reply.author.type).toBe("agent");
		expect(reply.text).toBe("I added @Acme Roofing to Clients. Secret Merger is not mine to share.");
		expect(reply.parts.find((p) => p.type === "text")).toMatchObject({ text: reply.text });
		expect(reply.records.map((r) => r.id)).toEqual([acme]);
		const row = await stored(reply._id);
		expect(row.text).toBe(`I added <record:${acme}> to Clients. Secret Merger is not mine to share.`);
		expect(row.mentions.recordIds).toEqual([acme]);
		expect((await mentionsOf(acme)).map((m) => m.messageId)).toEqual([reply._id]);
		expect(await mentionsOf(secret)).toEqual([]);
	});

	it("reads tags in its prompt as it writes them, named only when its person can see the record", async () => {
		const { t, owner, member, acme, secret, general, send } = await setup();
		await send(owner, `See [@Acme](record:${acme}) and [@Secret](record:${secret})`);
		const { companybot } = await agentsOf(member);
		const turnId = await agentTurn(t, member, general, companybot._id);
		const context = await t.mutation(internal.turns.turnContext, { turnId });
		const line = context.messages.find((m) => m.text.startsWith("See"))!;
		expect(line.text).toBe(`See [@Acme Roofing](record:${acme}) and a private record`);
	});
});
