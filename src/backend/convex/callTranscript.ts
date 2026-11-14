import { v, type Infer } from "convex/values";

/** Provider speaker identities describe distinct voices, not verified caller/staff roles. */
export const callTranscriptTurn = v.object({ speaker: v.string(), text: v.string(), start: v.number(), end: v.number() });
export type CallTranscriptTurn = Infer<typeof callTranscriptTurn>;
export const MAX_TRANSCRIPT_TURNS = 4_000;

export function validTranscriptTurns(turns: CallTranscriptTurn[]) {
	return turns.length <= MAX_TRANSCRIPT_TURNS && turns.every(turn => turn.speaker.length > 0 && turn.speaker.length <= 80 && turn.text.trim().length > 0 && Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.start >= 0 && turn.end >= turn.start) && turns.reduce((n, turn) => n + turn.text.length, 0) <= 120_000;
}

/** Keep the provider's identities and times; missing attribution must never become invented dialogue. */
export function speakerTurns(words: unknown): CallTranscriptTurn[] | null {
	if (!Array.isArray(words)) return null;
	const turns: CallTranscriptTurn[] = [];
	for (const value of words) {
		if (!value || typeof value !== "object") return null;
		const word = value as Record<string, unknown>;
		if (word.type === "audio_event") continue;
		if (word.type === "spacing") continue;
		if (word.type !== "word" || typeof word.text !== "string") return null;
		const text = word.text.trim();
		if (!text) continue;
		if (typeof word.speaker_id !== "string" || !word.speaker_id || word.speaker_id.length > 80 || typeof word.start !== "number" || typeof word.end !== "number" || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start) return null;
		const last = turns.at(-1);
		if (last?.speaker === word.speaker_id) {
			last.text += ` ${text}`;
			last.end = Math.max(last.end, word.end);
		} else turns.push({ speaker: word.speaker_id, text, start: word.start, end: word.end });
		if (turns.length > MAX_TRANSCRIPT_TURNS) return null;
	}
	return validTranscriptTurns(turns) ? turns : null;
}

/** Agent reads and summaries get the same attributed conversation as the call viewer. */
export function transcriptText(turns: CallTranscriptTurn[]) {
	const speakers = new Map<string, number>();
	return turns.map(turn => {
		if (!speakers.has(turn.speaker)) speakers.set(turn.speaker, speakers.size + 1);
		return `Speaker ${speakers.get(turn.speaker)}: ${turn.text}`;
	}).join("\n\n");
}
