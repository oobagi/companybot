export type RecordingTarget = { id: string; conversationId: string; name: string };
export type PlaybackSnapshot = {
	target: RecordingTarget | null;
	time: number;
	duration: number;
	playing: boolean;
	busy: boolean;
	error: string;
	loaded: boolean;
};

const empty = (): PlaybackSnapshot => ({ target: null, time: 0, duration: 0, playing: false, busy: false, error: "", loaded: false });
type Session = {
	audio: HTMLAudioElement;
	request: number;
	playRequest: number;
	wanted: boolean;
	renewed: boolean;
	phase: "idle" | "fetch" | "media" | "ready";
	url: string | null;
	restoreAt: number;
	removeListeners: () => void;
};

/** One media owner above the routes. Views subscribe to this store and never own its lifetime. */
export function createRecordingPlayback({ createAudio, playback }: { createAudio: () => HTMLAudioElement; playback: (id: string) => Promise<{ url: string }> }) {
	let state = empty();
	let session: Session | null = null;
	let disposed = false;
	const listeners = new Set<() => void>();
	const current = (s: Session) => !disposed && session === s;
	const update = (next: Partial<PlaybackSnapshot>) => {
		if (Object.entries(next).every(([key, value]) => state[key as keyof PlaybackSnapshot] === value)) return;
		state = { ...state, ...next };
		for (const listener of listeners) listener();
	};
	const release = (s: Session) => {
		s.wanted = false;
		s.request++;
		s.playRequest++;
		s.removeListeners();
		s.audio.pause();
		s.audio.removeAttribute("src");
		s.audio.load();
	};
	const clear = () => {
		const old = session;
		session = null;
		if (old) release(old);
		update(empty());
	};
	const failed = (s: Session, error: unknown) => {
		if (!current(s)) return;
		s.wanted = false;
		s.playRequest++;
		s.audio.pause();
		update({ playing: false, busy: false, error: error instanceof Error ? error.message : "Couldn't play the recording. Press Play to try again." });
	};
	const play = (s: Session) => {
		if (!current(s) || !s.wanted) return;
		if (s.audio.ended || (state.duration > 0 && s.audio.currentTime >= state.duration)) {
			s.audio.currentTime = 0;
			update({ time: 0 });
		}
		const request = ++s.playRequest;
		update({ busy: true, error: "" });
		try {
			void Promise.resolve(s.audio.play()).then(() => {
				if (!current(s)) { s.audio.pause(); return; }
				if (request !== s.playRequest) {
					if (!s.wanted || s.phase !== "ready") s.audio.pause();
					return;
				}
				if (!s.wanted) { s.audio.pause(); return; }
				update({ playing: !s.audio.paused, busy: false });
			}, error => {
				if (!current(s) || request !== s.playRequest || !s.wanted) return;
				failed(s, error);
			});
		} catch (error) { failed(s, error); }
	};
	const load = async (s: Session, id: string, at: number) => {
		const request = ++s.request;
		s.playRequest++;
		s.phase = "fetch";
		s.restoreAt = at;
		s.audio.pause();
		update({ busy: s.wanted, playing: false, loaded: false, error: "" });
		try {
			const result = await playback(id);
			if (!current(s) || request !== s.request) return;
			s.phase = "media";
			s.url = result.url;
			s.audio.src = result.url;
			s.audio.preload = "metadata";
			s.audio.load();
		} catch (error) {
			if (!current(s) || request !== s.request) return;
			s.phase = "idle";
			s.url = null;
			failed(s, error);
			s.audio.removeAttribute("src");
			s.audio.load();
		}
	};
	const pause = () => {
		if (!session || disposed) return;
		session.wanted = false;
		session.playRequest++;
		session.audio.pause();
		update({ playing: false, busy: false });
	};
	const makeSession = (target: RecordingTarget): Session => {
		const audio = createAudio();
		const s: Session = { audio, request: 0, playRequest: 0, wanted: true, renewed: false, phase: "idle", url: null, restoreAt: 0, removeListeners: () => {} };
		const handlers: Record<string, () => void> = {
			loadedmetadata: () => {
				if (!current(s) || s.phase !== "media") return;
				s.phase = "ready";
				const duration = Number.isFinite(audio.duration) && audio.duration >= 0 ? audio.duration : 0;
				const time = Math.min(duration, Math.max(0, s.restoreAt));
				if (time > 0) audio.currentTime = time;
				update({ duration, time, loaded: true, busy: false });
				play(s);
			},
			durationchange: () => {
				if (current(s) && s.phase !== "fetch" && Number.isFinite(audio.duration) && audio.duration >= 0) update({ duration: audio.duration });
			},
			timeupdate: () => {
				if (current(s) && s.phase === "ready" && Number.isFinite(audio.currentTime)) update({ time: Math.max(0, audio.currentTime) });
			},
			play: () => {
				if (!current(s)) return;
				if (!s.wanted || s.phase !== "ready") { audio.pause(); return; }
				update({ playing: true });
			},
			playing: () => {
				if (!current(s)) return;
				if (!s.wanted || s.phase !== "ready") { audio.pause(); return; }
				s.renewed = false;
				update({ playing: true, busy: false });
			},
			waiting: () => { if (current(s) && s.wanted) update({ busy: true }); },
			canplay: () => { if (current(s) && s.phase === "ready") update({ busy: false }); },
			pause: () => {
				if (!current(s)) return;
				update({ playing: false });
			},
			ended: () => {
				if (!current(s)) return;
				s.wanted = false;
				update({ playing: false, busy: false, time: Number.isFinite(audio.currentTime) ? audio.currentTime : state.time });
			},
			error: () => {
				if (!current(s) || s.phase === "fetch" || !s.url) return;
				if (!s.renewed) {
					s.renewed = true;
					void load(s, target.id, state.time);
					return;
				}
				s.request++;
				s.phase = "idle";
				s.url = null;
				failed(s, new Error("Couldn't play the recording. Press Play to reload it and check access."));
				audio.removeAttribute("src");
				audio.load();
				update({ loaded: false });
			},
		};
		for (const [event, handler] of Object.entries(handlers)) audio.addEventListener(event, handler);
		s.removeListeners = () => { for (const [event, handler] of Object.entries(handlers)) audio.removeEventListener(event, handler); };
		return s;
	};
	return {
		getSnapshot: () => state,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		toggle: (target: RecordingTarget) => {
			if (disposed) return;
			if (session && state.target?.id === target.id) {
				update({ target });
				if (session.wanted || state.playing) { pause(); return; }
				session.wanted = true;
				if (session.phase === "ready" && state.loaded) play(session);
				else if (session.phase === "fetch" || session.phase === "media") update({ busy: true, error: "" });
				else { session.renewed = false; void load(session, target.id, state.time); }
				return;
			}
			const old = session;
			session = null;
			if (old) release(old);
			update({ ...empty(), target });
			try {
				session = makeSession(target);
				void load(session, target.id, 0);
			} catch (error) { update({ error: error instanceof Error ? error.message : "Couldn't open the recording." }); }
		},
		seek: (seconds: number) => {
			if (disposed || !session || state.duration <= 0 || !Number.isFinite(seconds)) return;
			const time = Math.min(state.duration, Math.max(0, seconds));
			session.restoreAt = time;
			if (session.phase === "ready") session.audio.currentTime = time;
			update({ time });
		},
		pause,
		clear,
		dispose: () => { if (disposed) return; disposed = true; clear(); listeners.clear(); },
	};
}
