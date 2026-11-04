import { afterEach, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { definitionOf, triggerIndexes } from "../convex/automationOps";
import { automationJob, automationJobs } from "./automationJobs";
import { newTest, signIn, generalOf, noMentions } from "./helpers";

afterEach(() => vi.useRealTimers());

it("only wakes matching channel watchers; channel-less retained triggers stay inactive", async () => {
	vi.useFakeTimers();
	const t = newTest();
	const owner = await signIn(t, "routing@co.com");
	const chatId = (await generalOf(owner))._id;
	const other = await owner.mutation(api.chats.createChannel, { name: "other", private: false });
	const agentId = (await owner.query(api.agents.list))[0]!._id;
	// No automation exists: sending queues no automation dispatcher.
	await owner.mutation(api.messages.send, { chatId, text: "No watchers", mentions: noMentions });
	expect(await automationJob(t)).toBe(false);
	for (const [name, channelId] of [["Here", chatId], ["Elsewhere", other], ["Anywhere", other]] as const) {
		await owner.mutation(api.automations.create, { config: { name, prompt: "Read", trigger: { type: "event", event: "message.posted", channelId } }, agentId, audience: "creator", timeZone: "UTC" });
	}
	await t.run(async ctx => {
		const install = (await ctx.db.query("automationInstalls").collect()).find(i => i.custom?.name === "Anywhere")!;
		const definition = (await definitionOf(ctx, install, null))!;
		definition.trigger = { type: "event", event: "message.posted", label: "Any message" };
		const updated = { ...install, custom: undefined, definition };
		await ctx.db.patch(install._id, { custom: undefined, definition, ...triggerIndexes(updated, Date.now()) });
	});
	await owner.mutation(api.messages.send, { chatId, text: "Watched", mentions: noMentions });
	await automationJobs(t);
	const runs = await t.run(ctx => ctx.db.query("chatMessages").collect());
	expect(runs.filter(m => m.automation).map(m => m.automation!.name).sort()).toEqual(["Here"]);
});

it.each([false, true])("skips a deleted triggering message (subscriber fan-out: %s)", async subscribers => {
	vi.useFakeTimers();
	const t = newTest();
	const owner = await signIn(t, "deleted@co.com");
	const chatId = (await generalOf(owner))._id;
	const agentId = (await owner.query(api.agents.list))[0]!._id;
	await owner.mutation(api.automations.create, { config: { name: "Watch", prompt: "Read", trigger: { type: "event", event: "message.posted", channelId: chatId } }, agentId, audience: subscribers ? "subscribers" : "channel", channelId: subscribers ? undefined : chatId, timeZone: "UTC" });
	const messageId = await owner.mutation(api.messages.send, { chatId, text: "Delete me", mentions: noMentions });
	if (subscribers) {
		// Advance dispatch and the install worker, then delete before the delivery page posts.
		while (await t.run(async ctx => !(await ctx.db.system.query("_scheduled_functions").collect()).some(j => j.state.kind === "pending" && j.name === "automationRuns:fanOut"))) {
			expect(await automationJob(t)).toBe(true);
		}
	}
	await t.run(ctx => ctx.db.patch(messageId, { deleted: true }));
	await automationJobs(t);
	expect((await t.run(ctx => ctx.db.query("chatMessages").collect())).filter(m => m.automation)).toHaveLength(0);
});
