import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import { useAction } from "../../convex";

// Voice dictation: record a short clip with MediaRecorder and have the backend transcribe it
// (backend/convex/dictation.ts). Chrome's Web Speech API doesn't work in Electron.

/** Stops by itself here, well under the backend's size limit. */
export const MAX_RECORDING_MS = 2 * 60 * 1000;

const ERROR_MS = 6000;

/** What MediaRecorder can make, best first: Chromium (Electron) does webm/opus. */
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export const pickMimeType = (isSupported: (type: string) => boolean) => MIME_TYPES.find(isSupported);

/** `text` ready to insert after `before`: a space between words, none after a space or line start. */
export function spaced(before: string, text: string) {
	const t = text.trim();
	return t && before && !/\s$/.test(before) ? ` ${t}` : t;
}

/** Why the microphone couldn't be used, in a line people can act on. */
export function micError(e: unknown) {
	const name = (e as { name?: string } | null)?.name;
	if (name === "NotAllowedError" || name === "SecurityError") return "Allow microphone access for Companybot in your system settings.";
	if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found.";
	return errorMessage(e);
}

/**
 * Asks for the microphone one request at a time: while one is pending, another resolves to nothing
 * (a double click starts one recording). A stream granted after `keep()` turns false, because the
 * composer closed or a recording already runs, has its tracks stopped so the mic goes off.
 */
export function micOnce(getUserMedia: () => Promise<MediaStream>) {
	let pending = false;
	return async (keep: () => boolean) => {
		if (pending) return;
		pending = true;
		try {
			const stream = await getUserMedia();
			if (keep()) return stream;
			stream.getTracks().forEach((t) => t.stop());
		} finally {
			pending = false;
		}
	};
}

export type DictationState = "idle" | "recording" | "transcribing";

/** Click to start, click again to stop and get the words; `onText` receives them. */
export function useDictation(onText: (text: string) => void) {
	const transcribe = useAction(api.dictation.transcribeAudio);
	const [state, setState] = useState<DictationState>("idle");
	const [error, setError] = useState<string>();
	const recorder = useRef<MediaRecorder>(undefined);
	const mounted = useRef(false);
	const [openMic] = useState(() => micOnce(() => navigator.mediaDevices.getUserMedia({ audio: true })));
	const latest = useRef({ onText, transcribe });
	latest.current = { onText, transcribe };

	// An error is a note for a moment, not a state to dismiss.
	useEffect(() => {
		if (!error) return;
		const timer = setTimeout(() => setError(undefined), ERROR_MS);
		return () => clearTimeout(timer);
	}, [error]);

	const stop = () => recorder.current?.state === "recording" && recorder.current.stop();
	// Leaving the composer mid-recording lets go of the microphone and drops the clip; mid-start, `openMic` does.
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			const r = recorder.current;
			if (!r || r.state === "inactive") return;
			r.ondataavailable = r.onstop = null;
			r.stop();
			r.stream.getTracks().forEach((t) => t.stop());
		};
	}, []);

	const start = async () => {
		setError(undefined);
		try {
			const stream = await openMic(() => mounted.current && recorder.current?.state !== "recording");
			if (!stream) return;
			const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
			const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
			const chunks: Blob[] = [];
			const limit = setTimeout(stop, MAX_RECORDING_MS);
			rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
			rec.onstop = async () => {
				clearTimeout(limit);
				stream.getTracks().forEach((t) => t.stop());
				setState("transcribing");
				try {
					const text = await latest.current.transcribe({ audio: await new Blob(chunks).arrayBuffer() });
					if (text.trim()) latest.current.onText(text);
				} catch (e) {
					setError(errorMessage(e));
				}
				setState("idle");
			};
			recorder.current = rec;
			rec.start();
			setState("recording");
		} catch (e) {
			setError(micError(e));
			setState("idle");
		}
	};

	return { state, error, toggle: () => (state === "recording" ? stop() : state === "idle" && void start()) };
}
