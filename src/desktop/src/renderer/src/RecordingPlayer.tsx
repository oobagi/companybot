import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { useAction, useQuery } from "./convex";
import { CloseIcon, PauseIcon, PlayIcon, ReloadIcon, SpinnerIcon } from "./icons";
import { navigate, useRoute } from "./router";
import { callBarNameButton, iconButton, playerButton, smallButton } from "./ui";
import { createRecordingPlayback, type PlaybackSnapshot, type RecordingTarget } from "./recordingPlayback";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const empty: PlaybackSnapshot = { target: null, time: 0, duration: 0, playing: false, busy: false, error: "", loaded: false };
const getEmpty = () => empty;
const subscribeNothing = () => () => {};
type Controller = ReturnType<typeof createRecordingPlayback>;
type PlaybackContext = {
	snapshot: PlaybackSnapshot;
	blocked: boolean;
	toggle: (target: RecordingTarget) => void;
	seek: (seconds: number) => void;
	clear: () => void;
};
const RecordingContext = createContext<PlaybackContext | null>(null);

/** One media session per signed-in workspace, above every route. Screens contain controls, never the audio. */
export function RecordingPlaybackProvider({ enabled, interrupted, children }: { enabled: boolean; interrupted: boolean; children: React.ReactNode }) {
	const playback = useAction(api.callRecordings.playback);
	const [controller, setController] = useState<Controller | null>(null);
	useEffect(() => {
		const next = createRecordingPlayback({ createAudio: () => new Audio(), playback: id => playback({ id: id as Id<"inboxMessages"> }) });
		setController(next);
		return () => next.dispose();
	}, [playback]);
	const snapshot = useSyncExternalStore(controller?.subscribe ?? subscribeNothing, controller?.getSnapshot ?? getEmpty);
	const available = useQuery(api.callRecordings.availability, enabled && snapshot.target ? { id: snapshot.target.id as Id<"inboxMessages"> } : "skip");
	useEffect(() => {
		if (!enabled || available === false) controller?.clear();
	}, [controller, enabled, available]);
	useEffect(() => {
		if (interrupted) controller?.pause();
	}, [controller, interrupted]);
	const value = useMemo<PlaybackContext>(() => ({
		snapshot,
		blocked: !controller || !enabled || interrupted,
		toggle: target => {
			if (enabled && !interrupted && !(snapshot.target?.id === target.id && available === false)) controller?.toggle(target);
		},
		seek: seconds => { if (enabled && !interrupted) controller?.seek(seconds); },
		clear: () => controller?.clear(),
	}), [snapshot, controller, enabled, interrupted, available]);
	return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}

export function useRecordingPlayback() {
	const value = useContext(RecordingContext);
	if (!value) throw new Error("Recording controls must be inside the workspace playback provider.");
	return value;
}

const SKIP_SECONDS = 5;

/** A recording's place in time: drag or click to move, arrow keys skip five seconds, Home and End jump to the ends. */
function Scrubber({ time, duration, playing, blocked, onSeek }: { time: number; duration: number; playing: boolean; blocked: boolean; onSeek: (seconds: number) => void }) {
	const disabled = blocked || !duration;
	const percent = !duration ? 0 : Math.min(100, (time / duration) * 100);
	const point = (e: React.PointerEvent<HTMLDivElement>) => {
		const box = e.currentTarget.getBoundingClientRect();
		onSeek(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * duration);
	};
	const key = (e: React.KeyboardEvent) => {
		const to =
			e.key === "ArrowRight" || e.key === "ArrowUp" ? time + SKIP_SECONDS
				: e.key === "ArrowLeft" || e.key === "ArrowDown" ? time - SKIP_SECONDS
					: e.key === "PageUp" ? time + duration / 10
						: e.key === "PageDown" ? time - duration / 10
							: e.key === "Home" ? 0
								: e.key === "End" ? duration
									: null;
		if (to === null || disabled) return;
		e.preventDefault();
		onSeek(Math.min(duration, Math.max(0, to)));
	};
	return (
		<div
			role="slider"
			tabIndex={disabled ? -1 : 0}
			aria-label="Seek"
			aria-disabled={disabled}
			aria-valuemin={0}
			aria-valuemax={Math.floor(duration)}
			aria-valuenow={Math.floor(time)}
			aria-valuetext={!duration ? "Unknown length" : `${clock(Math.floor(time))} of ${clock(Math.floor(duration))}`}
			className={`group relative flex h-8 min-w-0 flex-1 touch-none items-center outline-none ${disabled ? "" : "cursor-pointer"}`}
			onPointerDown={(e) => {
				if (disabled || e.button !== 0) return;
				e.currentTarget.setPointerCapture(e.pointerId);
				point(e);
			}}
			onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && point(e)}
			onKeyDown={key}
		>
			<div className="h-1 w-full overflow-hidden rounded-full bg-neutral-300">
				<div className={`h-full rounded-full bg-neutral-900 ${playing ? "transition-[width] duration-200 ease-linear group-active:transition-none" : ""}`} style={{ width: `${percent}%` }} />
			</div>
			{!disabled && (
				<span
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-900 opacity-0 ring-neutral-500 ring-offset-2 ring-offset-neutral-200 group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-visible:ring-2 group-active:opacity-100"
					style={{ left: `${percent}%` }}
				/>
			)}
		</div>
	);
}

/** Every occurrence of the active recording controls the same audio and position. */
export function RecordingControls({ target }: { target: RecordingTarget }) {
	const { snapshot, blocked, toggle, seek } = useRecordingPlayback();
	const selected = snapshot.target?.id === target.id;
	const playing = selected && snapshot.playing;
	const busy = selected && snapshot.busy;
	const time = selected ? snapshot.time : 0;
	const duration = selected && snapshot.loaded ? snapshot.duration : 0;
	const error = selected ? snapshot.error : "";
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div role="group" aria-label="Call recording" className="flex h-11 items-center gap-2 rounded-xl bg-neutral-200/70 pr-3.5 pl-1.5">
				<button type="button" aria-label={playing || busy ? "Pause recording" : "Play recording"} title={blocked ? "Finish the call to listen" : playing || busy ? "Pause" : "Play"} disabled={blocked} className={playerButton} onClick={() => toggle(target)}>
					{busy ? <SpinnerIcon className="animate-spin" /> : playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
				</button>
				<Scrubber time={time} duration={duration} playing={playing} blocked={blocked} onSeek={seek} />
				<span className="shrink-0 text-xs text-neutral-500 tabular-nums">{clock(Math.floor(time))}{duration > 0 && ` / ${clock(Math.floor(duration))}`}</span>
			</div>
			{error && (
				<div className="flex items-start gap-2 px-1 text-sm text-red-600">
					<p role="alert" className="min-w-0 flex-1 break-words">{error}</p>
					<button type="button" className={smallButton} disabled={blocked} onClick={() => toggle(target)}><ReloadIcon /> Try again</button>
				</div>
			)}
		</div>
	);
}

/** Part of the app shell, so changing screens leaves playback and its controls available. */
export function RecordingDock() {
	const { snapshot, clear } = useRecordingPlayback();
	const route = useRoute();
	const target = snapshot.target;
	if (!target || (route[0] === "inbox" && route[1] === target.conversationId && route[2] === "call" && route[3] === target.id)) return null;
	return (
		<section aria-label="Recording playback" className="flex shrink-0 items-center gap-3 border-t border-neutral-200 bg-white px-3 py-2">
			<button type="button" className={callBarNameButton} title="Open call" onClick={() => navigate("inbox", target.conversationId, "call", target.id)}>{target.name}</button>
			<div className="min-w-0 flex-1"><RecordingControls target={target} /></div>
			<button type="button" className={iconButton} aria-label="Stop recording playback" title="Stop playback" onClick={clear}><CloseIcon /></button>
		</section>
	);
}
