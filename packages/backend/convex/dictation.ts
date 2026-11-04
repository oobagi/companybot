import { gatewayCost } from "@companybot/core";
import { getAuthUserId } from "@convex-dev/auth/server";
import { experimental_transcribe as transcribe, gateway } from "ai";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./functions";

// Voice dictation for the chat composer. Chrome's Web Speech API doesn't work in Electron, so
// the app records a short clip (MediaRecorder) and sends it here; AI Gateway transcribes it and
// the app puts the text in the box. Same key as the agents' models (AI_GATEWAY_API_KEY).

/** Cheap (~$0.003 a minute, billed by tokens), takes webm/opus as recorded, and is on AI Gateway. */
export const DICTATION_MODEL = "openai/gpt-4o-mini-transcribe";
/** Under Convex's 5 MiB action-argument limit, so a big clip gets this message, not a transport error. Two minutes of webm/opus is ~1 MB. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** The words in a clip and what the gateway charged for them. */
export async function transcribeClip(audio: Uint8Array): Promise<{ text: string; costUsd: number }> {
	const result = await transcribe({ model: gateway.transcription(DICTATION_MODEL), audio });
	return { text: result.text.trim(), costUsd: gatewayCost(result.providerMetadata) };
}

/** Turns a recorded clip into text. Anyone in a workspace can dictate. */
export const transcribeAudio = action({
	args: { audio: v.bytes() },
	handler: async (ctx, { audio }): Promise<string> => {
		const userId = await getAuthUserId(ctx);
		const workspaceId = userId && (await ctx.runQuery(internal.permissions.workspaceOf, { userId, workspaceId: ctx.workspaceId }));
		if (!userId || !workspaceId) throw new ConvexError("Sign in to a workspace first.");
		if (audio.byteLength === 0) return "";
		if (audio.byteLength > MAX_AUDIO_BYTES) throw new ConvexError("That recording is too long. Try a shorter one.");
		const { text, costUsd } = await transcribeClip(new Uint8Array(audio));
		await ctx.runMutation(internal.usage.record, { workspaceId, userId, kind: "dictation", model: DICTATION_MODEL, costUsd });
		return text;
	},
});
