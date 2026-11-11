"use node";

import { AccessToken, RoomServiceClient, SipClient, SipCallError, TrackSource, WebhookReceiver } from "livekit-server-sdk";
import { ConvexError, v } from "convex/values";
import { api, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { action } from "./functions";

// One media adapter. No voice agent, worker, second phone history, or keys in the renderer.
const config = () => {
	const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
	if (!url || !key || !secret) throw new ConvexError("Calling is not set up yet.");
	return { url, key, secret };
};

export const join = action({
	args: { id: v.id("inboxMessages") },
	handler: async (ctx, { id }): Promise<{ url: string; token: string }> => {
		const c = config();
		const target = await ctx.runMutation(api.calls.join, { workspaceId: ctx.workspaceId, id });
		const token = new AccessToken(c.key, c.secret, { identity: target.identity, ttl: 60 });
		token.addGrant({ roomJoin: true, room: target.room, canPublish: true, canPublishSources: [TrackSource.MICROPHONE], canSubscribe: true, canPublishData: true });
		return { url: c.url, token: await token.toJwt() };
	},
});

export const dial = internalAction({
	args: { id: v.id("inboxMessages") },
	handler: async (ctx, { id }) => {
		const target = await ctx.runMutation(internal.calls.claimDial, { id });
		if (!target) return;
		try {
			const c = config();
			await new SipClient(c.url, c.key, c.secret).createSipParticipant(process.env.LIVEKIT_SIP_OUTBOUND_TRUNK!, target.to, target.room, { fromNumber: target.from, participantIdentity: "caller", ringingTimeout: 30, maxCallDuration: 1800, playDialtone: true, waitUntilAnswered: true });
			if (!(await ctx.runMutation(internal.calls.connected, { id }))) await ctx.runAction(internal.phoneProvider.close, { room: target.room, id });
		} catch (error) {
			// A SIP rejection is known. A lost response may already have called; never redial.
			const code = error instanceof SipCallError ? error.sipStatusCode : undefined;
			const outcome = code === 486 || code === 603 ? "declined" as const : code === 408 || code === 480 ? "no-answer" as const : code && code >= 300 ? "failed" as const : undefined;
			await ctx.runMutation(internal.calls.closed, { id, ...(outcome ? { outcome } : { uncertain: true }) });
			await ctx.runAction(internal.phoneProvider.close, { room: target.room });
		}
	},
});

export const close = internalAction({
	args: { room: v.string(), id: v.optional(v.id("inboxMessages")), attempt: v.optional(v.number()) },
	handler: async (ctx, { room, id, attempt = 0 }) => {
		try {
			const c = config();
			await new RoomServiceClient(c.url, c.key, c.secret).deleteRoom(room);
		} catch (e) {
			if (!(e && typeof e === "object" && "code" in e && e.code === "not_found")) {
				if (attempt < 3) return void await ctx.scheduler.runAfter(1000 * 2 ** attempt, internal.phoneProvider.close, { room, ...(id && { id }), attempt: attempt + 1 });
				if (id) await ctx.runMutation(internal.calls.closed, { id, uncertain: true });
				console.error("A phone room could not be closed. Check LiveKit.");
				return;
			}
		}
		if (id) await ctx.runMutation(internal.calls.closed, { id });
	},
});

export const event = internalAction({
	args: { body: v.string(), authorization: v.string() },
	handler: async (ctx, { body, authorization }): Promise<boolean> => {
		const c = config();
		let event;
		try { event = await new WebhookReceiver(c.key, c.secret).receive(body, authorization); }
		catch { return false; }
		const room = event.room?.name;
		if (!room?.startsWith("cb-call-")) return true;
		const p = event.participant;
		await ctx.runMutation(internal.calls.event, { event: event.event, room, identity: p?.identity ?? "", sip: p?.kind === 3, attributes: p?.attributes ?? {}, disconnectReason: (p?.toJson() as { disconnectReason?: string } | undefined)?.disconnectReason ?? "" });
		return true;
	},
});
