"use node";

import { Expo, type ExpoPushTicket } from "expo-server-sdk";
import { Agent } from "undici";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

// The official Expo SDK owns payload validation/chunking, connection limits and 429 retries.
// Our durable outbox owns authorization, bounded retry, receipts and registration lifecycle.
const expo = new Expo({
	accessToken: process.env.EXPO_ACCESS_TOKEN,
	maxConcurrentRequests: 1,
	httpAgent: new Agent({ connect: { timeout: 10_000 }, headersTimeout: 30_000, bodyTimeout: 30_000 }),
});
type Result = { id: Id<"mobilePushDeliveries">; outcome: "ok" | "retry" | "resend" | "failed" | "unregistered"; ticketId?: string };
const outcome = (ticket: ExpoPushTicket): Result["outcome"] => ticket.status === "ok" ? "ok" : ticket.details?.error === "DeviceNotRegistered" ? "unregistered" : ["MessageRateExceeded", "ExpoError", "ProviderError"].includes(ticket.details?.error ?? "") ? "retry" : "failed";
const retryable = (error: unknown) => {
	const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : undefined;
	return status === undefined || status === 429 || status >= 500;
};

export const send = internalAction({
	args: {},
	handler: async (ctx) => {
		const batch = await ctx.runMutation(internal.mobileNotifications.claim, { kind: "send" });
		if (!batch) return;
		let results: Result[] = [];
		try {
			if (batch.jobs.length) {
				// Separate read transactions keep an account with many chats out of the claim write budget.
				const badges = new Map<Id<"users">, number>();
				for (const job of batch.jobs) if (!badges.has(job.userId)) badges.set(job.userId, await ctx.runQuery(internal.mobileNotifications.badgeForUser, { userId: job.userId }));
				const tickets = await expo.sendPushNotificationsAsync(batch.jobs.map((job) => ({
					to: job.token, title: "Companybot", body: "You have a new message.",
					data: { deliveryId: job.id }, badge: badges.get(job.userId) ?? 0, channelId: "messages", sound: "default", ttl: 3600,
					// A retry can be accepted twice after a connection loss; replace that same delivery on Android.
					tag: job.id, collapseId: job.id,
				})));
				results = tickets.map((ticket, index) => ({ id: batch.jobs[index]!.id, outcome: outcome(ticket), ...(ticket.status === "ok" && { ticketId: ticket.id }) }));
			}
		} catch (error) {
			// Never log tokens or the SDK's raw errors: they can include the request body.
			results = batch.jobs.map((job) => ({ id: job.id, outcome: retryable(error) ? "retry" : "failed" }));
		}
		await ctx.runMutation(internal.mobileNotifications.complete, { kind: "send", lease: batch.lease, results });
	},
});

export const receipts = internalAction({
	args: {},
	handler: async (ctx) => {
		const batch = await ctx.runMutation(internal.mobileNotifications.claim, { kind: "receipt" });
		if (!batch) return;
		let results: Result[] = [];
		try {
			if (batch.jobs.length) {
				const receipts = await expo.getPushNotificationReceiptsAsync(batch.jobs.flatMap((job) => job.ticketId ? [job.ticketId] : []));
				results = batch.jobs.map((job) => {
					const receipt = job.ticketId ? receipts[job.ticketId] : undefined;
					const state = !receipt ? "retry" : receipt.status === "ok" ? "ok" : outcome(receipt);
					return { id: job.id, outcome: receipt && state === "retry" ? "resend" : state };
				});
			}
		} catch (error) {
			results = batch.jobs.map((job) => ({ id: job.id, outcome: retryable(error) ? "retry" : "failed" }));
		}
		await ctx.runMutation(internal.mobileNotifications.complete, { kind: "receipt", lease: batch.lease, results });
	},
});
