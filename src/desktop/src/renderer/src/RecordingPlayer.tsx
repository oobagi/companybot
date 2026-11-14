import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { useAction, useQuery } from "./convex";
import { CloseIcon, PauseIcon, PlayIcon, ReloadIcon, SpinnerIcon, WarningIcon } from "./icons";
import { navigate } from "./router";
import { noticeButton, playBarButton, playBarNameButton, playBarPlayButton, playerButton, Problem } from "./ui";
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

/**
 * A recording's place in time: drag or click to move, arrow keys skip five seconds, Home and End jump to the ends.
 * `compact` is the title bar's: a short fixed track on white, where the full one fills its grey bar.
 */
function Scrubber({ time, duration, playing, blocked, compact, onSeek }: { time: number; duration: number; playing: boolean; blocked: boolean; compact?: boolean; onSeek: (seconds: number) => void }) {
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
			className={`group relative flex touch-none items-center outline-none ${compact ? "no-drag h-7 w-24 shrink-0 max-md:w-14" : "h-8 min-w-0 flex-1"} ${disabled ? "" : "cursor-pointer"}`}
			onPointerDown={(e) => {
				if (disabled || e.button !== 0) return;
				e.currentTarget.setPointerCapture(e.pointerId);
				point(e);
			}}
			onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && point(e)}
			onKeyDown={key}
		>
			<div className={`h-1 w-full overflow-hidden rounded-full ${compact ? "bg-neutral-200" : "bg-neutral-300"}`}>
				<div className={`h-full rounded-full bg-neutral-900 ${playing ? "transition-[width] duration-200 ease-linear group-active:transition-none" : ""}`} style={{ width: `${percent}%` }} />
			</div>
			{!disabled && (
				<span
					aria-hidden="true"
					className={`pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-900 opacity-0 ring-neutral-500 ring-offset-2 group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-visible:ring-2 group-active:opacity-100 ${compact ? "size-2.5 ring-offset-white" : "size-3 ring-offset-neutral-200"}`}
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
				<div className="px-1">
					<Problem alert message="The recording didn't play" detail={error}>
						<button type="button" className={noticeButton} disabled={blocked} onClick={() => toggle(target)}><ReloadIcon aria-hidden="true" /> Try again</button>
					</Problem>
				</div>
			)}
		</div>
	);
}

/**
 * The title bar's player, beside the call pill: what's playing stays in reach on every screen and covers nothing.
 * It stays on the call's own screen too, beside the full player in the call header. The name goes back to the call.
 */
export function RecordingPill() {
	const { snapshot, blocked, toggle, seek, clear } = useRecordingPlayback();
	const target = snapshot.target;
	if (!target) return null;
	const active = snapshot.playing || snapshot.busy;
	const duration = snapshot.loaded ? snapshot.duration : 0;
	return (
		<section aria-label="Recording playback" className="no-drag mx-1 flex h-7 min-w-0 items-center gap-2 rounded-full bg-white px-0.5 text-xs ring-1 ring-neutral-200">
			<button type="button" aria-label={active ? "Pause recording" : "Play recording"} title={blocked ? "Finish the call to listen" : active ? "Pause" : snapshot.error ? "Try again" : "Play"} disabled={blocked} className={playBarPlayButton} onClick={() => toggle(target)}>
				{snapshot.busy ? <SpinnerIcon className="animate-spin" /> : snapshot.playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
			</button>
			<button type="button" className={playBarNameButton} title="Open call" onClick={() => navigate("inbox", target.conversationId, "call", target.id)}>{target.name}</button>
			<Scrubber compact time={snapshot.time} duration={duration} playing={snapshot.playing} blocked={blocked} onSeek={seek} />
			{snapshot.error ? (
				<span role="alert" title={`The recording didn't play. ${snapshot.error}`} className="flex shrink-0 items-center text-sm text-amber-600">
					<WarningIcon aria-hidden="true" /> <span className="sr-only">The recording didn't play. Play again to retry.</span>
				</span>
			) : (
				<span className="shrink-0 text-neutral-500 tabular-nums" title={duration > 0 ? `${clock(Math.floor(snapshot.time))} of ${clock(Math.floor(duration))}` : undefined}>{clock(Math.floor(snapshot.time))}</span>
			)}
			<button type="button" className={playBarButton} aria-label="Stop recording playback" title="Stop playback" onClick={clear}><CloseIcon /></button>
		</section>
	);
}
