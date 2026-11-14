import { type McpPart, sniffImage } from "@companybot/core";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { type ActionCtx, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { query } from "./functions";
import { getMember } from "./lib";
import { runningTurn } from "./turns";
import { canReadReplyDetails } from "./replyPrivacy";
import { canSee } from "./chatOps";

export const save = internalMutation({
	args: { turnId: v.id("agentTurns"), callId: v.string(), storageId: v.id("_storage"), mimeType: v.string() },
	handler: async (ctx, { turnId, callId, storageId, mimeType }) => {
		const { turn, member } = await runningTurn(ctx, turnId);
		const existing = await ctx.db.query("connectorArtifacts").withIndex("by_turn", q => q.eq("turnId", turnId)).take(20);
		if (existing.length >= 20) throw new Error("This reply has reached its limit of 20 connector artifacts.");
		return ctx.db.insert("connectorArtifacts", { turnId, callId, workspaceId: member.workspaceId, userId: member.userId, memberId: member.id, replyId: turn.replyId!, storageId, mimeType });
	},
});
export const get = query({
	args: { id: v.id("connectorArtifacts") },
	handler: async (ctx, { id }) => {
		const member = await getMember(ctx);
		const artifact = await ctx.db.get(id);
		if (!member || !artifact || artifact.workspaceId !== member.workspaceId || artifact.userId !== member.userId || artifact.memberId !== member.id) return null;
		const reply = await ctx.db.get(artifact.replyId);
		const chat = reply && await ctx.db.get(reply.chatId);
		if (!reply || !chat || !await canSee(ctx, chat, member) || !await canReadReplyDetails(ctx, member, reply)) return null;
		return { url: await ctx.storage.getUrl(artifact.storageId), mimeType: artifact.mimeType };
	},
});

/** Never fetch a returned resource URI. Only bytes supplied by the connected server are stored. */
export async function persistConnectorContent(ctx: Pick<ActionCtx, "storage" | "runMutation">, turnId: Id<"agentTurns">, parts: McpPart[], callId: string, vision = true): Promise<McpPart[]> {
	const out: McpPart[] = [];
	let textBytes = 0;
	for (const part of parts) {
		if (part.type === "text" || part.type === "resource_link" || part.type === "resource" && part.resource.text !== undefined) {
			textBytes += new TextEncoder().encode(JSON.stringify(part)).length;
			if (textBytes > 32000) throw new Error("Connector text exceeds 32 KB. Request a smaller result.");
			// Remove server-supplied url/artifactId extensions; only our storage path can set those.
			out.push(part.type === "text" ? { type: "text", text: part.text } : part.type === "resource_link" ? { type: "resource_link", uri: part.uri, name: part.name, ...(part.description && { description: part.description }), ...(part.mimeType && { mimeType: part.mimeType }) } : { type: "resource", resource: { uri: part.resource.uri, text: part.resource.text!, ...(part.resource.mimeType && { mimeType: part.resource.mimeType }) } });
			continue;
		}
		if (part.type !== "image" && part.type !== "audio" && part.type !== "resource") throw new Error("Unsupported MCP content type.");
		const data = part.type === "resource" ? part.resource.blob : part.data;
		const mimeType = part.type === "resource" ? part.resource.mimeType ?? "application/octet-stream" : part.mimeType;
		if (!data || data.length > 8 * 1024 * 1024 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Invalid or oversized connector media (maximum 6 MiB per file).");
		const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
		if (part.type === "image" && sniffImage(bytes) !== mimeType) throw new Error("Connector image bytes do not match their media type.");
		if (part.type === "audio" && !["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/flac", "audio/mp4", "audio/webm"].includes(mimeType)) throw new Error("Unsupported connector audio type.");
		// Unknown embedded blobs are download-only; never serve executable markup as HTML/SVG.
		const servedType = part.type === "resource" ? "application/octet-stream" : mimeType;
		const storageId = await ctx.storage.store(new Blob([bytes], { type: servedType }));
		try {
			const artifactId = await ctx.runMutation(internal.connectorArtifacts.save, { turnId, callId, storageId, mimeType: servedType });
			const url = (await ctx.storage.getUrl(storageId))!;
			out.push(part.type === "resource" ? { type: "resource", resource: { uri: part.resource.uri, mimeType }, url, artifactId, modelSupported: false } : { type: part.type, mimeType, url, artifactId, modelSupported: part.type === "image" && vision });
		} catch (e) { await ctx.storage.delete(storageId); throw e; }
	}
	return out;
}

/** Media remains available even when the activity's text excerpt was clipped or the tool reported an error. */
export const forCall = query({
	args: { activityId: v.id("agentActivity") },
	handler: async (ctx, { activityId }) => {
		const member = await getMember(ctx);
		const activity = await ctx.db.get(activityId);
		if (!member || !activity || !activity.turnId || activity.workspaceId !== member.workspaceId || activity.actorId !== member.userId) return [];
		const reply = activity.replyId && await ctx.db.get(activity.replyId);
		const chat = reply && await ctx.db.get(reply.chatId);
		if (!reply || !chat || !await canSee(ctx, chat, member) || !await canReadReplyDetails(ctx, member, reply)) return [];
		const rows = await ctx.db.query("connectorArtifacts").withIndex("by_turn", q => q.eq("turnId", activity.turnId!)).take(20);
		return Promise.all(rows.filter(r => r.memberId === member.id && r.callId === activity.callId).map(async r => ({ id: r._id, mimeType: r.mimeType, url: await ctx.storage.getUrl(r.storageId) })));
	},
});
