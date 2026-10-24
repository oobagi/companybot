import {
	type Automation,
	automationCatalog,
	can,
	describeTrigger,
	eventPrompt,
	findAutomation,
	findPlugin,
	grantedPluginIds,
	isValidTimeZone,
	localTime,
	parseEventBody,
	scheduleDue,
} from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { type MutationCtx, type QueryCtx, internalMutation, mutation, query } from "./_generated/server";
import { addToChat, canSee, findOrCreateDm, insertMessage } from "./chatOps";
import { getMember, normalizeEmail, requireAgent, requirePermission } from "./lib";
import { enqueueTurn } from "./turns";

// Install → pick the agent → it runs on its trigger. Each run posts the automation's
// prompt in the agent's DM with each person it runs for and queues a turn acting as
// them, so the reply uses their permissions and plugin accounts (wiki/chat.md). With a
// channel picked, a run posts there once instead, acting as the owner who picked it.

function requireAutomation(automationId: string): Automation {
	const automation = findAutomation(automationId);
	if (!automation) throw new ConvexError("Unknown automation.");
	return automation;
}

const installOf = (ctx: QueryCtx, workspaceId: Id<"workspaces">, automationId: string) =>
	ctx.db
		.query("automationInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId).eq("automationId", automationId))
		.first();

async function installedPluginIds(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const installs = await ctx.db
		.query("pluginInstalls")
		.withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
		.collect();
	return new Set(installs.map((i) => i.pluginId));
}

/** The secret in an event automation's webhook URL. */
function newWebhookToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const webhookUrl = (token: string) => `${process.env.CONVEX_SITE_URL ?? ""}/automations/${token}`;

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		const canManage = can(member.role, "automations.manage");
		const plugins = await installedPluginIds(ctx, member.workspaceId);
		return Promise.all(
			automationCatalog.map(async (automation) => {
				const install = await installOf(ctx, member.workspaceId, automation.id);
				const agent = install && (await ctx.db.get(install.agentId));
				const granted = agent ? grantedPluginIds(agent) : [];
				const channel = install?.channelId && (await ctx.db.get(install.channelId));
				const scheduled = automation.trigger.type === "schedule";
				return {
					id: automation.id,
					name: automation.name,
					description: automation.description,
					details: automation.details,
					version: automation.version,
					publisher: automation.publisher,
					trigger: describeTrigger(automation.trigger),
					scheduled,
					runsFor: channel
						? `Posts once in #${channel.name}`
						: scheduled
							? "Everyone in the workspace, in their chat with the agent"
							: "The person each event is about, in their chat with the agent",
					prompt: automation.prompt,
					needs: automation.plugins.map((id) => ({
						id,
						name: findPlugin(id)?.name ?? id,
						installed: plugins.has(id),
						granted: granted.includes(id),
					})),
					installed: !!install,
					enabled: install?.enabled ?? false,
					agentId: install?.agentId ?? null,
					agentName: agent?.name ?? null,
					agentArchived: agent?.archived ?? false,
					channelId: install?.channelId ?? null,
					channelName: channel ? channel.name! : null,
					channelArchived: channel ? channel.archived : false,
					/** Secret: owners only. */
					webhookUrl: canManage && install?.webhookToken ? webhookUrl(install.webhookToken) : null,
					timeZone: install?.timeZone ?? null,
					lastRunAt: install?.lastRunAt ?? null,
					lastResult: install?.lastResult ?? null,
				};
			}),
		);
	},
});

export const setInstalled = mutation({
	args: { automationId: v.string(), installed: v.boolean(), timeZone: v.string() },
	handler: async (ctx, { automationId, installed, timeZone }) => {
		const owner = await requirePermission(ctx, "automations.manage");
		const automation = requireAutomation(automationId);
		const existing = await installOf(ctx, owner.workspaceId, automationId);
		if (!installed) {
			if (existing) {
				await ctx.db.delete(existing._id);
				const events = ctx.db.query("automationEvents").withIndex("by_install", (q) => q.eq("installId", existing._id));
				for await (const event of events) await ctx.db.delete(event._id);
			}
			return;
		}
		if (existing) return;
		if (!isValidTimeZone(timeZone)) throw new ConvexError("Unknown time zone.");
		const plugins = await installedPluginIds(ctx, owner.workspaceId);
		const missing = automation.plugins.filter((id) => !plugins.has(id)).map((id) => findPlugin(id)?.name ?? id);
		if (missing.length > 0) throw new ConvexError(`Install the ${missing.join(", ")} plugin first.`);
		const agent = await ctx.db
			.query("agents")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", owner.workspaceId))
			.filter((q) => q.eq(q.field("archived"), false))
			.first();
		if (!agent) throw new ConvexError("Create an agent first.");
		// Installed after today's time: start tomorrow rather than firing right away.
		const now = localTime(Date.now(), timeZone);
		const startsTomorrow = automation.trigger.type === "schedule" && now.time >= automation.trigger.time;
		await ctx.db.insert("automationInstalls", {
			workspaceId: owner.workspaceId,
			automationId,
			agentId: agent._id,
			enabled: true,
			timeZone,
			installedBy: owner.userId,
			lastRunDate: startsTomorrow ? now.date : undefined,
			webhookToken: automation.trigger.type === "event" ? newWebhookToken() : undefined,
		});
	},
});

export const update = mutation({
	args: {
		automationId: v.string(),
		enabled: v.optional(v.boolean()),
		agentId: v.optional(v.id("agents")),
		/** A channel to post in, or null for each person's DM. */
		channelId: v.optional(v.union(v.id("chats"), v.null())),
	},
	handler: async (ctx, { automationId, enabled, agentId, channelId }) => {
		const owner = await requirePermission(ctx, "automations.manage");
		const install = await installOf(ctx, owner.workspaceId, automationId);
		if (!install) throw new ConvexError("Install it first.");
		if (agentId) {
			const agent = await requireAgent(ctx, owner, agentId);
			if (agent.archived) throw new ConvexError("That agent is archived.");
		}
		if (channelId) {
			const chat = await ctx.db.get(channelId);
			if (!chat || chat.kind !== "channel" || chat.archived || !(await canSee(ctx, chat, owner)))
				throw new ConvexError("That channel isn't available.");
		}
		await ctx.db.patch(install._id, {
			...(enabled !== undefined && { enabled }),
			...(agentId && { agentId }),
			...(channelId !== undefined && { channelId: channelId ?? undefined, channelSetBy: channelId ? owner.userId : undefined }),
		});
	},
});

/** A new webhook URL; the old one stops working. */
export const resetWebhook = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => {
		const owner = await requirePermission(ctx, "automations.manage");
		const install = await installOf(ctx, owner.workspaceId, automationId);
		if (!install?.webhookToken) throw new ConvexError("This automation has no webhook.");
		await ctx.db.patch(install._id, { webhookToken: newWebhookToken() });
	},
});

/** Runs it once now, for the owner alone (events use a sample), so they can see what it does. */
export const runNow = mutation({
	args: { automationId: v.string() },
	handler: async (ctx, { automationId }) => {
		const owner = await requirePermission(ctx, "automations.manage");
		const automation = requireAutomation(automationId);
		const install = await installOf(ctx, owner.workspaceId, automationId);
		if (!install) throw new ConvexError("Install it first.");
		const prompt = automation.trigger.type === "event" ? eventPrompt(automation, automation.trigger.sample.data) : automation.prompt;
		const result = await runInDms(ctx, install, automation, [owner.userId], prompt);
		if (!result.ran) throw new ConvexError(result.summary);
	},
});

// ---- Internal: triggers ----

/** Runs every few minutes (crons.ts): starts the scheduled automations that are due. */
export const tick = internalMutation({
	args: {},
	handler: async (ctx) => {
		const installs = await ctx.db
			.query("automationInstalls")
			.withIndex("by_enabled", (q) => q.eq("enabled", true))
			.collect();
		for (const install of installs) {
			const automation = findAutomation(install.automationId);
			if (!automation) continue;
			const due = scheduleDue(automation.trigger, Date.now(), install.timeZone, install.lastRunDate);
			if (!due) continue;
			await ctx.db.patch(install._id, { lastRunDate: due });
			if (install.channelId) {
				await runInChannel(ctx, install, automation, automation.prompt);
				continue;
			}
			const members = await ctx.db
				.query("members")
				.withIndex("by_workspace", (q) => q.eq("workspaceId", install.workspaceId))
				.collect();
			await runInDms(
				ctx,
				install,
				automation,
				members.map((m) => m.userId),
				automation.prompt,
			);
		}
	},
});

/**
 * A webhook delivery (http.ts): runs the event automation whose URL this is. Repeats
 * of an event id are ignored, so senders can retry safely. Returns the HTTP reply.
 */
export const receive = internalMutation({
	args: { token: v.string(), body: v.string() },
	handler: async (ctx, { token, body }): Promise<{ status: number; ok: boolean; message: string }> => {
		const install = token
			? await ctx.db
					.query("automationInstalls")
					.withIndex("by_webhook", (q) => q.eq("webhookToken", token))
					.first()
			: null;
		const automation = install && findAutomation(install.automationId);
		if (!install || automation?.trigger.type !== "event") return { status: 404, ok: false, message: "Unknown webhook URL." };
		let json: unknown;
		try {
			json = JSON.parse(body);
		} catch {
			return { status: 400, ok: false, message: "Body isn't JSON." };
		}
		const event = parseEventBody(json);
		if (typeof event === "string") return { status: 400, ok: false, message: event };
		if (event.event !== automation.trigger.event)
			return { status: 400, ok: false, message: `This URL takes ${automation.trigger.event} events.` };
		if (!install.enabled) return { status: 200, ok: true, message: "Not run: the automation is off." };

		const seen = await ctx.db
			.query("automationEvents")
			.withIndex("by_install", (q) => q.eq("installId", install._id).eq("eventId", event.id))
			.first();
		if (seen) return { status: 200, ok: true, message: "Already received." };
		await ctx.db.insert("automationEvents", { installId: install._id, eventId: event.id });

		const prompt = eventPrompt(automation, event.data);
		if (install.channelId) return { status: 200, ok: true, message: (await runInChannel(ctx, install, automation, prompt)).summary };
		const userId = event.person && (await workspaceUserByEmail(ctx, install.workspaceId, event.person.email));
		if (!userId) {
			const summary = event.person
				? `Didn't run: nobody here has the email ${event.person.email}. Pick a channel to post every event there.`
				: "Didn't run: the event didn't say who it's for. Pick a channel to post events there.";
			return { status: 200, ok: true, message: await finish(ctx, install, summary) };
		}
		return { status: 200, ok: true, message: (await runInDms(ctx, install, automation, [userId], prompt)).summary };
	},
});

/** Event ids are kept this long: far past any sender's retries. */
export const EVENT_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

/** Runs hourly (crons.ts): deletes event ids older than EVENT_MEMORY_MS, in batches. */
export const forgetOldEvents = internalMutation({
	args: {},
	handler: async (ctx) => {
		const old = await ctx.db
			.query("automationEvents")
			.withIndex("by_creation_time", (q) => q.lt("_creationTime", Date.now() - EVENT_MEMORY_MS))
			.take(500);
		for (const event of old) await ctx.db.delete(event._id);
		if (old.length === 500) await ctx.scheduler.runAfter(0, internal.automations.forgetOldEvents);
	},
});

async function workspaceUserByEmail(ctx: QueryCtx, workspaceId: Id<"workspaces">, email: string) {
	const user = await ctx.db
		.query("users")
		.withIndex("email", (q) => q.eq("email", normalizeEmail(email)))
		.first();
	if (!user) return null;
	const member = await ctx.db
		.query("members")
		.withIndex("by_user", (q) => q.eq("userId", user._id))
		.first();
	return member?.workspaceId === workspaceId ? user._id : null;
}

/** Records what a run did, for its detail page, and returns the line. */
async function finish(ctx: MutationCtx, install: Doc<"automationInstalls">, summary: string) {
	await ctx.db.patch(install._id, { lastRunAt: Date.now(), lastResult: summary });
	return summary;
}

async function activeAgent(ctx: QueryCtx, install: Doc<"automationInstalls">) {
	const agent = await ctx.db.get(install.agentId);
	return agent && !agent.archived ? agent : null;
}

const noAgent = "Didn't run: its agent is archived or deleted. Pick another agent.";

/**
 * Posts the prompt in each person's DM with the agent, as them, and queues the agent's
 * reply there. The turn queue handles a reply already running, so nobody is skipped.
 */
async function runInDms(
	ctx: MutationCtx,
	install: Doc<"automationInstalls">,
	automation: Automation,
	userIds: Id<"users">[],
	prompt: string,
) {
	const agent = await activeAgent(ctx, install);
	if (!agent) return { ran: false, summary: await finish(ctx, install, noAgent) };
	for (const userId of userIds) {
		const chatId = await findOrCreateDm(ctx, install.workspaceId, userId, [userId], [agent._id]);
		const chat = (await ctx.db.get(chatId))!;
		const triggerId = await insertMessage(ctx, chat, {
			authorUserId: userId,
			text: prompt,
			parts: [{ type: "text", text: prompt }],
			mentions: { userIds: [], agentIds: [] },
			status: "done",
			automation: { id: automation.id, name: automation.name },
		});
		await enqueueTurn(ctx, chat, { agentId: agent._id, chatId, triggerId, actorId: userId });
	}
	const sent = userIds.length;
	return { ran: true, summary: await finish(ctx, install, `Sent to ${sent} ${sent === 1 ? "person" : "people"}.`) };
}

/**
 * Posts the prompt once in the install's channel and queues the agent's reply there,
 * acting as the owner who picked the channel, or another owner who can see it if
 * they've left, so a run never depends on one person staying.
 */
async function runInChannel(ctx: MutationCtx, install: Doc<"automationInstalls">, automation: Automation, prompt: string) {
	const agent = await activeAgent(ctx, install);
	if (!agent) return { ran: false, summary: await finish(ctx, install, noAgent) };
	const chat = install.channelId && (await ctx.db.get(install.channelId));
	if (!chat || chat.archived)
		return { ran: false, summary: await finish(ctx, install, "Didn't run: its channel was archived or deleted. Pick another.") };
	const owners = (
		await ctx.db
			.query("members")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", install.workspaceId))
			.collect()
	)
		.filter((m) => m.role === "owner")
		.sort((a, b) => Number(b.userId === install.channelSetBy) - Number(a.userId === install.channelSetBy));
	let actorId: Id<"users"> | null = null;
	for (const owner of owners) {
		if (await canSee(ctx, chat, owner)) {
			actorId = owner.userId;
			break;
		}
	}
	if (!actorId)
		return { ran: false, summary: await finish(ctx, install, `Didn't run: no owner is in #${chat.name}. Pick another channel.`) };
	await addToChat(ctx, chat, { agentId: agent._id });
	const triggerId = await insertMessage(ctx, chat, {
		authorUserId: actorId,
		text: prompt,
		parts: [{ type: "text", text: prompt }],
		mentions: { userIds: [], agentIds: [agent._id] },
		status: "done",
		automation: { id: automation.id, name: automation.name },
	});
	await enqueueTurn(ctx, chat, { agentId: agent._id, chatId: chat._id, triggerId, actorId });
	return { ran: true, summary: await finish(ctx, install, `Posted in #${chat.name}.`) };
}
