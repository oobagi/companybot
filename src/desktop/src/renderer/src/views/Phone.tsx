import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatPhone } from "@companybot/core/inbox";
import type { FunctionReturnType } from "convex/server";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Room } from "livekit-client";
import { api, errorMessage } from "../api";
import { useAction, useMutation, useQuery } from "../convex";
import { BackspaceIcon, CaretDownIcon, KeypadIcon, MicrophoneIcon, MicrophoneSlashIcon, PhoneDisconnectIcon, PhoneIcon, PhoneIncomingIcon, PhoneOutgoingIcon, PopInIcon, PopOutIcon, ReloadIcon, SparkleIcon, SpeakerIcon, SpinnerIcon, WarningIcon } from "../icons";
import { navigate } from "../router";
import { RecordingControls, RecordingPlaybackProvider } from "../RecordingPlayer";
import {
	answerButton,
	callBarButton,
	callBarHangUpButton,
	callBarNameButton,
	compactButton,
	declineButton,
	dialDeleteButton,
	dialKeyButton,
	hangUpButton,
	labelButton,
	phoneCallerButton,
	phoneToolButton,
	placeCallButton,
	roundCallButton,
	rowButton,
	smallButton,
	smallIconButton,
	titleBarButton,
	callOpenButton,
	conversationColumn,
	Scroll,
} from "../ui";
import { Avatar, dayLabel, clock as timeOfDay } from "./chat/common";

type Target = { agentId?: Id<"agents">; to?: string; recordId?: Id<"records"> };
type Current = NonNullable<FunctionReturnType<typeof api.calls.current>>["calls"][number];
type Numbers = FunctionReturnType<typeof api.calls.numbers>;

/** Everything the phone's pieces (title bar pill, panel, Call buttons) share. The call itself lives in `Phone`. */
type PhoneState = {
	open: (target: Target) => void;
	toggle: () => void;
	shown: boolean;
	mine: Current | undefined;
	incoming: Current | undefined;
	connected: boolean;
	muted: boolean;
	busy: boolean;
	silent: boolean;
	join: () => void;
	answer: () => void;
	decline: () => void;
	mute: () => void;
	hangUp: () => void;
	unblockAudio: () => void;
};
const PhoneContext = createContext<PhoneState | null>(null);

/** "Call" wherever a person or number is: opens the phone with the number filled in. `round`: just the green phone, as a composer's send. */
export function CallButton({ agentId, to, recordId, children = "Call", round }: Target & { children?: React.ReactNode; round?: boolean }) {
	const phone = useContext(PhoneContext);
	const record = useQuery(api.calls.forRecord, phone && !to && recordId ? { recordId } : "skip");
	if (!phone) return null;
	const busy = phone.mine ? "Finish your current call first" : undefined;
	const open = () => phone.open({ agentId, to: to ?? record?.phones[0] ?? "", recordId });
	if (round)
		return (
			<button type="button" aria-label="Call" title={busy ?? "Call"} disabled={!!busy} className={roundCallButton} onClick={open}>
				<PhoneIcon weight="fill" />
			</button>
		);
	return (
		<button type="button" disabled={!!busy} title={busy} className={compactButton} onClick={open}>
			<PhoneIcon /> {children}
		</button>
	);
}

/** A number as it's typed, spaced the way it's said: "(415) 555-01", "+1 (415) 555-0142"; anything else as typed. */
function asTyped(raw: string) {
	const us = /^(\+?1)?(\d{0,3})(\d{0,3})(\d{0,4})$/.exec(raw);
	if (!us || raw.length < 4 || /[*#]/.test(raw)) return raw;
	const [, country, a, b, c] = us;
	const local = `(${a}${a!.length === 3 ? ")" : ""}${b ? ` ${b}` : ""}${c ? `-${c}` : ""}`;
	return country ? `${country.startsWith("+") ? country : `+${country}`} ${local}` : local;
}
/** Shrinks the dialer's number until it fits its field, so it's never cut off. Re-measures every render. */
function useFitText() {
	const ref = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		for (const px of [30, 26, 22, 18, 15]) {
			el.style.fontSize = `${px}px`;
			if (el.scrollWidth <= el.clientWidth) break;
		}
	});
	return ref;
}
const nameOf = (call: { name: string; contact: string }) => (call.name === call.contact ? formatPhone(call.contact) : call.name);
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const since = (at: number | null) => (at === null ? 0 : Math.max(0, Math.floor((Date.now() - at) / 1000)));

/** Re-renders every second while `on`, for a running call timer. */
function useTick(on: boolean) {
	const [, tick] = useState(0);
	useEffect(() => {
		if (!on) return;
		const t = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, [on]);
}

/**
 * Above all routes, keyed to the workspace/account, so navigation never drops a call. The phone is a
 * floating panel (`FloatingPanel`) you toggle from the title bar, drag and throw to a corner, or pop
 * out into its own window. The call's audio always stays in this window, so popping out never drops it.
 */
export function Phone({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
	const current = useQuery(api.calls.current, enabled ? {} : "skip");
	const numbers = useQuery(api.calls.numbers, enabled ? {} : "skip");
	const readiness = useQuery(api.calls.readiness, enabled ? {} : "skip");
	const start = useMutation(api.calls.start);
	const joinRoom = useAction(api.phoneProvider.join);
	const ready = useMutation(api.calls.ready);
	const end = useMutation(api.calls.end);
	const declineCall = useMutation(api.calls.decline);
	const [shown, setShown] = useState(false);
	const [target, setTarget] = useState<Target>({});
	const [digits, setDigits] = useState("");
	const [agentId, setAgent] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [muted, setMuted] = useState(false);
	const [connected, setConnected] = useState(false);
	const [silent, setSilent] = useState(false);
	const audio = useRef<HTMLDivElement>(null);
	const session = useRef<{ room: Room; id: Id<"inboxMessages"> } | null>(null);
	const joining = useRef(false);
	const mounted = useRef(true);
	const mine = current?.calls.find((c) => c.mine);
	const incoming = current?.calls.find((c) => !c.mine);
	const leave = () => {
		const old = session.current;
		session.current = null;
		if (old) {
			old.room.removeAllListeners();
			void old.room.disconnect();
		}
		audio.current?.replaceChildren();
		if (mounted.current) {
			setConnected(false);
			setMuted(false);
			setSilent(false);
		}
	};
	const fail = (e: unknown) => {
		if (!mounted.current) return;
		setError(errorMessage(e));
		setShown(true);
	};
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			const id = session.current?.id;
			leave();
			if (id) void end({ id }).catch(() => {});
		};
	}, []);
	useEffect(() => {
		if (!enabled || current === null || (!mine && current !== undefined)) leave();
	}, [enabled, current, mine?.id]);
	// A ringing call opens the phone, wherever it was left.
	useEffect(() => {
		if (incoming) setShown(true);
	}, [incoming?.id]);
	useEffect(() => {
		if (!incoming || mine) return;
		let context: AudioContext;
		try {
			context = new AudioContext();
		} catch {
			return;
		}
		const ring = () => {
			if (context.state !== "running") return; // Browsers may require a prior gesture for audio.
			const tone = context.createOscillator();
			const gain = context.createGain();
			tone.frequency.value = 440;
			gain.gain.value = 0.05;
			tone.connect(gain);
			gain.connect(context.destination);
			tone.start();
			tone.stop(context.currentTime + 0.25);
		};
		ring();
		const timer = setInterval(ring, 2000);
		return () => {
			clearInterval(timer);
			void context.close();
		};
	}, [incoming?.id, mine?.id]);
	// A provider disconnect also ends the server call. It must never keep billing after this tab lost audio.
	const connect = async (id: Id<"inboxMessages">) => {
		if (joining.current || session.current) return;
		joining.current = true;
		setBusy(true);
		setError("");
		let stream: MediaStream | undefined;
		try {
			try {
				stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			} catch {
				throw new Error("Allow microphone access to make and take calls.");
			}
			if (!mounted.current) return;
			const credentials = await joinRoom({ id });
			if (!mounted.current) {
				void end({ id });
				return;
			}
			const { Room, RoomEvent, Track, LocalAudioTrack } = await import("livekit-client");
			const room = new Room();
			session.current = { room, id };
			room.on(RoomEvent.TrackSubscribed, (track) => {
				if (track.kind === Track.Kind.Audio) audio.current?.append(track.attach());
			});
			room.on(RoomEvent.TrackUnsubscribed, (track) => {
				track.detach().forEach((el) => el.remove());
			});
			room.on(RoomEvent.AudioPlaybackStatusChanged, () => setSilent(!room.canPlaybackAudio));
			room.on(RoomEvent.Disconnected, () => {
				leave();
				void end({ id }).catch(() => {});
			});
			await room.connect(credentials.url, credentials.token);
			if (!mounted.current || session.current?.room !== room) {
				await room.disconnect();
				return;
			}
			await room.localParticipant.publishTrack(new LocalAudioTrack(stream.getAudioTracks()[0]!), { source: Track.Source.Microphone });
			await ready({ id });
			setConnected(true);
			setSilent(!room.canPlaybackAudio);
		} catch (e) {
			leave();
			void end({ id }).catch(() => {});
			fail(e);
		} finally {
			// Published tracks are now owned by Room; failed or late microphone grants are always stopped.
			if (!session.current) stream?.getTracks().forEach((t) => t.stop());
			joining.current = false;
			if (mounted.current) setBusy(false);
		}
	};
	const from = agentId || numbers?.[0]?.agentId || "";
	const place = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			if (!from) throw new Error("Give an agent a phone number first.");
			const id = await start({ agentId: from as Id<"agents">, to: digits, ...(target.recordId && { recordId: target.recordId }) });
			await connect(id);
		} catch (e) {
			fail(e);
		} finally {
			if (mounted.current) setBusy(false);
		}
	};
	const open = (t: Target) => {
		setTarget(t);
		// A US number fills in as it's said, without the +1.
		if (t.to !== undefined) setDigits(/^\+1\d{10}$/.test(t.to) ? t.to.slice(2) : t.to);
		else if (t.agentId || t.recordId) setDigits("");
		if (t.agentId) setAgent(t.agentId);
		setError("");
		setShown(true);
	};
	const tone = async (digit: string) => {
		try {
			await session.current?.room.localParticipant.publishDtmf(digit === "*" ? 10 : digit === "#" ? 11 : Number(digit), digit);
		} catch {
			setError("Couldn't send that key. Try again.");
		}
	};
	const phone: PhoneState = {
		open,
		toggle: () => setShown((s) => !s),
		shown,
		mine,
		incoming,
		connected,
		muted,
		busy,
		silent,
		join: () => mine && void connect(mine.id),
		answer: () => incoming && void connect(incoming.id),
		decline: () => incoming && void declineCall({ id: incoming.id }).catch(fail),
		mute: () => {
			const next = !muted;
			const room = session.current?.room;
			if (room) void room.localParticipant.setMicrophoneEnabled(!next).then(() => setMuted(next), () => setError("Couldn't change the microphone."));
		},
		hangUp: () => {
			if (!mine) return;
			leave();
			void end({ id: mine.id }).catch(fail);
		},
		unblockAudio: () => void session.current?.room.startAudio(),
	};
	// Whether a call can start, from the same check the server runs (budget, setup, a number); empty while it loads.
	const blocked = readiness === undefined ? "" : readiness?.canCall ? null : (readiness?.reason ?? "You can't make calls here.");
	return (
		<RecordingPlaybackProvider enabled={enabled} interrupted={!!mine || !!incoming || busy}>
			<PhoneContext.Provider value={enabled ? phone : null}>
				{children}
				<div ref={audio} className="hidden" />
				{enabled && (
					<FloatingPanel shown={shown} onClose={() => setShown(false)} title={mine ? "On a call" : incoming ? "Incoming call" : "Phone"}>
						<PhonePanel
							phone={phone}
							numbers={numbers ?? []}
							from={from}
							onFrom={setAgent}
							digits={digits}
							onDigits={setDigits}
							onTone={(d) => void tone(d)}
							onPlace={() => void place()}
							blocked={blocked}
							error={error}
						/>
					</FloatingPanel>
				)}
			</PhoneContext.Provider>
		</RecordingPlaybackProvider>
	);
}

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const EDGE = 12;
const TITLE_BAR = 32;
/** How far a throw carries past where it's let go, in ms of its speed: more feels heavier. */
const THROW_MS = 220;
const POPOUT = "companybot-phone";

const readCorner = (): Corner => {
	try {
		const saved = localStorage.getItem("phone.corner");
		return saved === "top-left" || saved === "top-right" || saved === "bottom-left" || saved === "bottom-right" ? saved : "bottom-right";
	} catch {
		return "bottom-right";
	}
};

/**
 * The phone's panel: floats over the app, dragged by its header and thrown to the nearest corner
 * (where the throw would carry it, not just where it's dropped), and settles with a little overshoot.
 * Pop out moves the same panel into a small window of its own, kept on top; closing that window brings it back.
 */
function FloatingPanel({ shown, title, onClose, children }: { shown: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
	const panel = useRef<HTMLDivElement>(null);
	const [corner, setCorner] = useState<Corner>(readCorner);
	const [size, setSize] = useState<{ w: number; h: number }>();
	const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
	const [drag, setDrag] = useState<{ x: number; y: number }>();
	const grab = useRef<{ dx: number; dy: number; samples: { x: number; y: number; t: number }[] }>(undefined);
	const [popped, setPopped] = useState<{ win: Window; root: HTMLElement }>();
	useLayoutEffect(() => {
		const el = panel.current;
		if (!el) return;
		const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [popped]);
	useEffect(() => {
		if (!shown) {
			setPopped(undefined);
			setDrag(undefined);
			grab.current = undefined;
		} else {
			panel.current?.querySelector<HTMLInputElement>('input[type="tel"]')?.focus();
		}
	}, [shown]);
	useEffect(() => {
		const resize = () => setView({ w: window.innerWidth, h: window.innerHeight });
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	// Closing the phone closes its window; the window closing on its own brings the panel back in.
	useEffect(() => {
		if (!popped) return;
		const back = () => setPopped(undefined);
		popped.win.addEventListener("pagehide", back);
		return () => {
			popped.win.removeEventListener("pagehide", back);
			popped.win.close();
		};
	}, [popped]);
	const at = (c: Corner) => {
		const w = size?.w ?? 0;
		const h = size?.h ?? 0;
		return { x: c.endsWith("left") ? EDGE : view.w - w - EDGE, y: c.startsWith("top") ? TITLE_BAR + EDGE : Math.max(TITLE_BAR + EDGE, view.h - h - EDGE) };
	};
	const pos = drag ?? at(corner);
	const down = (e: React.PointerEvent) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		grab.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] };
		setDrag(pos);
	};
	const move = (e: React.PointerEvent) => {
		const g = grab.current;
		if (!g) return;
		g.samples = [...g.samples, { x: e.clientX, y: e.clientY, t: e.timeStamp }].filter((s) => e.timeStamp - s.t < 100);
		setDrag({ x: e.clientX - g.dx, y: e.clientY - g.dy });
	};
	const up = (e: React.PointerEvent) => {
		const g = grab.current;
		grab.current = undefined;
		if (!g || !drag) return;
		const first = g.samples[0]!;
		const last = g.samples.at(-1)!;
		const dt = Math.max(1, last.t - first.t);
		const w = size?.w ?? 0;
		const h = size?.h ?? 0;
		// Where the throw would carry the panel's middle: that side of the screen wins.
		const x = drag.x + w / 2 + ((last.x - first.x) / dt) * THROW_MS;
		const y = drag.y + h / 2 + ((last.y - first.y) / dt) * THROW_MS;
		const next: Corner = `${y < view.h / 2 ? "top" : "bottom"}-${x < view.w / 2 ? "left" : "right"}`;
		setCorner(next);
		setDrag(undefined);
		try {
			localStorage.setItem("phone.corner", next);
		} catch {}
		e.currentTarget.releasePointerCapture(e.pointerId);
	};
	const popOut = () => {
		const win = window.open("", POPOUT, "popup,width=300,height=560");
		if (!win) return;
		// The same styles as the app, so the panel looks the same in its own window.
		win.document.head.replaceChildren(...[...document.querySelectorAll('style, link[rel="stylesheet"]')].map((n) => n.cloneNode(true)));
		win.document.title = "Phone";
		win.document.documentElement.className = document.documentElement.className;
		win.document.body.className = `${document.body.className} h-screen overflow-hidden bg-white`;
		const root = win.document.createElement("div");
		root.className = "h-full";
		win.document.body.replaceChildren(root);
		setPopped({ win, root });
	};
	const header = (
		<div onPointerDown={popped ? undefined : down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} className={`flex h-10 shrink-0 items-center gap-1 pr-1.5 pl-4 select-none ${popped ? "" : "cursor-grab touch-none active:cursor-grabbing"}`}>
			<p className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-500">{title}</p>
			{popped ? (
				<button type="button" aria-label="Put back in the app" title="Put back in the app" className={smallIconButton} onClick={() => setPopped(undefined)}>
					<PopInIcon />
				</button>
			) : (
				<button type="button" aria-label="Open in its own window" title="Open in its own window" className={smallIconButton} onClick={popOut}>
					<PopOutIcon />
				</button>
			)}
			<button type="button" aria-label="Hide phone" title="Hide phone" className={smallIconButton} onClick={onClose}>
				<CaretDownIcon />
			</button>
		</div>
	);
	if (popped)
		return createPortal(
			<div className="flex h-full flex-col bg-white text-body text-neutral-900">
				{header}
				<div className="flex flex-1 flex-col justify-center">{children}</div>
			</div>,
			popped.root,
		);
	return (
		<div
			ref={panel}
			role="dialog"
			aria-label="Phone"
			aria-hidden={!shown}
			inert={!shown}
			data-shown={shown && !!size}
			data-dragging={!!drag}
			style={{ "--x": `${pos.x}px`, "--y": `${pos.y}px`, "--phone-origin": corner.replace("-", " ") } as React.CSSProperties}
			className="phone-panel fixed top-0 left-0 z-50 flex w-80 translate-x-(--x) translate-y-(--y) flex-col overflow-hidden rounded-3xl border border-neutral-200 bg-white text-body text-neutral-900 shadow-2xl"
		>
			{header}
			{children}
		</div>
	);
}

const keys = [
	["1", ""],
	["2", "ABC"],
	["3", "DEF"],
	["4", "GHI"],
	["5", "JKL"],
	["6", "MNO"],
	["7", "PQRS"],
	["8", "TUV"],
	["9", "WXYZ"],
	["*", ""],
	["0", "+"],
	["#", ""],
] as const;

function Keypad({ onKey }: { onKey: (digit: string) => void }) {
	return (
		<div className="grid grid-cols-3 gap-x-5 gap-y-2.5">
			{keys.map(([d, letters]) => (
				<button key={d} type="button" onClick={() => onKey(d)} className={dialKeyButton}>
					<span className="text-2xl leading-none font-light">{d}</span>
					<span className="h-3 text-2xs font-medium tracking-widest text-neutral-500">{letters}</span>
				</button>
			))}
		</div>
	);
}

/** What the panel shows: a ringing call to answer, the call you're on, or the dialer. */
function PhonePanel(props: {
	phone: PhoneState;
	numbers: Numbers;
	from: string;
	onFrom: (agentId: string) => void;
	digits: string;
	onDigits: (digits: string) => void;
	onTone: (digit: string) => void;
	onPlace: () => void;
	blocked: string | null;
	error: string;
}) {
	const { phone, error } = props;
	const { mine, incoming } = phone;
	const [keypad, setKeypad] = useState(false);
	const [sent, setSent] = useState("");
	const [picking, setPicking] = useState(false);
	const numberRef = useFitText();
	useTick(mine?.state === "connected");
	useEffect(() => setKeypad(false), [mine?.id]);
	const errorLine = error && <p className="px-6 text-center text-sm text-red-600">{error}</p>;
	if (incoming && !mine)
		return (
			<div className="flex flex-col items-center gap-6 px-5 pt-4 pb-7">
				<Avatar name={nameOf(incoming)} size="lg" />
				<div className="text-center">
					<p className="text-xl font-semibold">{nameOf(incoming)}</p>
					<p className="text-sm text-neutral-500">{incoming.name === incoming.contact ? "Incoming call" : formatPhone(incoming.contact)}</p>
				</div>
				{errorLine}
				<div className="flex gap-12">
					<button type="button" aria-label="Decline" title="Decline" className={declineButton} onClick={phone.decline}>
						<PhoneDisconnectIcon weight="fill" />
					</button>
					<button type="button" aria-label="Answer" title="Answer" disabled={phone.busy} className={answerButton} onClick={phone.answer}>
						<PhoneIcon weight="fill" />
					</button>
				</div>
			</div>
		);
	if (mine) {
		const live = mine.state === "connected";
		const status = live ? clock(since(mine.connectedAt)) : mine.state === "ending" ? "Ending…" : mine.direction === "in" ? "Connecting…" : "Calling…";
		return (
			<div className="flex flex-col items-center gap-5 px-5 pt-2 pb-6">
				{keypad ? (
					<p className="h-14 w-full truncate pt-3 text-center text-3xl font-light tracking-wider tabular-nums" aria-live="polite">
						{sent || <span className="text-xl text-neutral-300">{nameOf(mine)}</span>}
					</p>
				) : (
					<button type="button" className={phoneCallerButton} onClick={() => navigate("inbox", mine.conversationId)} title="Open the conversation">
						<Avatar name={nameOf(mine)} size="lg" />
						<span className="text-xl font-semibold">{nameOf(mine)}</span>
					</button>
				)}
				<p className={`-mt-3 text-sm tabular-nums ${live ? "text-emerald-600" : "text-neutral-500"}`}>
					{keypad && sent ? `${nameOf(mine)} · ` : ""}
					{status}
				</p>
				{mine.recording?.status === "recording" && (
					<p role="status" className="-mt-3 flex items-center gap-1.5 text-xs text-neutral-500">
						<span aria-hidden="true" className="size-1.5 rounded-full bg-red-500" /> Recording
					</p>
				)}
				{(mine.recording?.status === "unavailable" || mine.recording?.status === "failed") && (
					<p role="status" className="-mt-3 text-center text-xs text-amber-700">{mine.recording.error || "Recording is unavailable for this call."}</p>
				)}
				{incoming && (
					<div className="flex w-full items-center gap-2 rounded-xl bg-neutral-100 py-1.5 pr-1.5 pl-3 text-sm">
						<PhoneIncomingIcon className="text-neutral-500" />
						<span className="min-w-0 flex-1 truncate">{nameOf(incoming)} is calling</span>
						<button type="button" className={compactButton} onClick={phone.decline}>
							Decline
						</button>
					</div>
				)}
				{errorLine}
				{keypad && <Keypad onKey={(d) => (setSent((s) => (s + d).slice(-16)), props.onTone(d))} />}
				{!phone.connected ? (
					<button type="button" className={compactButton} disabled={phone.busy || mine.state === "ending"} onClick={phone.join}>
						<MicrophoneIcon /> Join with microphone
					</button>
				) : (
					!keypad && (
						<div className="flex gap-5">
							<button type="button" aria-pressed={phone.muted} className={phoneToolButton} onClick={phone.mute}>
								{phone.muted ? <MicrophoneSlashIcon /> : <MicrophoneIcon />}
								<span>{phone.muted ? "Unmute" : "Mute"}</span>
							</button>
							<button type="button" disabled={!live} className={phoneToolButton} onClick={() => (setSent(""), setKeypad(true))}>
								<KeypadIcon />
								<span>Keypad</span>
							</button>
							{phone.silent && (
								<button type="button" className={phoneToolButton} onClick={phone.unblockAudio}>
									<SpeakerIcon />
									<span>Sound</span>
								</button>
							)}
						</div>
					)
				)}
				<div className="flex items-center gap-6">
					{keypad && <span className="w-16" />}
					<button type="button" aria-label="Hang up" title="Hang up" className={hangUpButton} onClick={phone.hangUp}>
						<PhoneDisconnectIcon weight="fill" />
					</button>
					{keypad && (
						<button type="button" className={`${labelButton} w-16 justify-center`} onClick={() => setKeypad(false)}>
							Hide
						</button>
					)}
				</div>
			</div>
		);
	}
	const fromNumber = props.numbers.find((n) => n.agentId === props.from);
	return (
		<form
			className="flex flex-col items-center gap-4 px-5 pt-1 pb-6"
			onSubmit={(e) => {
				e.preventDefault();
				props.onPlace();
			}}
		>
			{fromNumber &&
				(props.numbers.length > 1 ? (
					<button type="button" aria-expanded={picking} className={`${labelButton} text-sm`} onClick={() => setPicking(!picking)}>
						From {fromNumber.name} · {formatPhone(fromNumber.number)} <CaretDownIcon />
					</button>
				) : (
					<p className="text-sm text-neutral-500">
						From {fromNumber.name} · {formatPhone(fromNumber.number)}
					</p>
				))}
			{picking && (
				<div className="flex w-full flex-col rounded-xl border border-neutral-200 p-1">
					{props.numbers.map((n) => (
						<button key={n.agentId} type="button" data-active={n.agentId === props.from || undefined} className={rowButton} onClick={() => (props.onFrom(n.agentId), setPicking(false))}>
							{n.name} · {formatPhone(n.number)}
						</button>
					))}
				</div>
			)}
			<div className="relative flex w-full items-center">
				<input ref={numberRef} aria-label="Phone number" type="tel" placeholder="Enter a number" value={asTyped(props.digits)} onChange={(e) => props.onDigits(e.target.value.replace(/[^\d+*#]/g, ""))} className="h-12 min-w-0 flex-1 bg-transparent px-9 text-center font-light tabular-nums outline-none placeholder:text-lg placeholder:text-neutral-300" />
				<button type="button" aria-label="Delete" title="Delete" disabled={!props.digits} className={`absolute right-0 ${dialDeleteButton}`} onClick={() => props.onDigits(props.digits.slice(0, -1))}>
					<BackspaceIcon />
				</button>
			</div>
			<Keypad onKey={(d) => props.onDigits(props.digits + d)} />
			<button type="submit" aria-label="Call" title="Call" disabled={phone.busy || props.blocked !== null || !props.digits.trim()} className={placeCallButton}>
				<PhoneIcon weight="fill" />
			</button>
			{(error || props.blocked) && <p className={`text-center text-sm ${error ? "text-red-600" : "text-neutral-500"}`}>{error || props.blocked}</p>}
			<p className="text-xs text-neutral-400">Agents placing calls for you · Coming soon</p>
		</form>
	);
}

/**
 * The title bar's phone: toggles the panel, or, on a call, shows who it's with and how long, with mute and
 * hang up, so the call is in view even with the panel hidden. It sits in the title bar so it covers nothing.
 */
export function CallStatus() {
	const phone = useContext(PhoneContext);
	const call = phone?.mine;
	useTick(call?.state === "connected");
	if (!phone) return null;
	if (!call)
		return (
			<button type="button" aria-label={phone.shown ? "Hide phone" : "Phone"} title={phone.shown ? "Hide phone" : "Phone"} aria-pressed={phone.shown} className={titleBarButton} onClick={phone.toggle}>
				<PhoneIcon weight={phone.shown ? "fill" : "regular"} />
			</button>
		);
	const live = call.state === "connected";
	const status = live ? clock(since(call.connectedAt)) : call.state === "ending" ? "Ending…" : call.direction === "in" ? "Connecting…" : "Calling…";
	return (
		<div className="no-drag mx-1 flex h-7 items-center gap-1 rounded-full bg-neutral-900 pr-0.5 pl-2.5 text-xs text-white" aria-label="Current call">
			<span className={`size-2 shrink-0 rounded-full ${live ? "bg-emerald-400" : "animate-pulse bg-amber-400"}`} />
			<button type="button" className={callBarNameButton} title={phone.shown ? "Hide phone" : "Show phone"} onClick={phone.toggle}>
				<span className="max-sm:hidden">{nameOf(call)}</span> <span className="pl-1 font-normal text-neutral-400 tabular-nums">{status}</span>
			</button>
			{phone.connected && (
				<button type="button" aria-label={phone.muted ? "Unmute" : "Mute"} title={phone.muted ? "Unmute" : "Mute"} aria-pressed={phone.muted} className={callBarButton} onClick={phone.mute}>
					{phone.muted ? <MicrophoneSlashIcon /> : <MicrophoneIcon />}
				</button>
			)}
			<button type="button" aria-label="Hang up" title="Hang up" className={callBarHangUpButton} onClick={phone.hangUp}>
				<PhoneDisconnectIcon weight="fill" />
			</button>
		</div>
	);
}

type CallInfo = { direction: string; state: string; connectedAt: number | null; endedAt: number | null };

/** How a call went, in words: "Answered · 3:42", "Missed", "No answer". */
export function callStatus(call: CallInfo, answeredBy?: string | null) {
	const answered = call.connectedAt !== null;
	const seconds = answered ? Math.max(0, Math.floor(((call.endedAt ?? Date.now()) - call.connectedAt!) / 1000)) : 0;
	const tone: "live" | "good" | "bad" | "quiet" = call.state === "connected" ? "live" : answered ? "good" : call.state === "ringing" || call.state === "ending" || call.state === "unknown" ? "quiet" : "bad";
	const text =
		call.state === "connected"
			? `On the call · ${clock(seconds)}`
			: call.state === "ringing"
				? call.direction === "in" ? "Ringing…" : "Calling…"
				: call.state === "ending"
					? "Ending…"
					: answered
						? `${answeredBy && call.direction === "in" ? `Answered by ${answeredBy}` : "Answered"} · ${clock(seconds)}`
						: call.state === "failed"
							? "Didn't go through"
							: call.state === "declined"
								? "Declined"
							: call.state === "unknown"
								? "Ended"
								: call.direction === "in" ? "Missed" : "No answer";
	return { text, tone, seconds, answered };
}

const toneClass = { live: "bg-emerald-500 text-white", good: "bg-emerald-100 text-emerald-700", bad: "bg-red-100 text-red-600", quiet: "bg-neutral-200 text-neutral-500" };

export function CallIcon({ call, size = "md" }: { call: CallInfo; size?: "sm" | "md" }) {
	const { tone } = callStatus(call);
	const Icon = call.direction === "in" ? PhoneIncomingIcon : PhoneOutgoingIcon;
	return (
		<span className={`flex shrink-0 items-center justify-center rounded-full ${size === "md" ? "size-10 text-lg" : "size-7 text-sm"} ${toneClass[tone]}`}>
			<Icon weight="fill" />
		</span>
	);
}

type CallEntryInfo = NonNullable<NonNullable<FunctionReturnType<typeof api.inbox.get>>["messages"][number]["call"]>;

/** The card and detail view control the workspace's shared media session. */
function CallRecording({ call }: { call: CallEntryInfo }) {
	return <RecordingControls target={{ id: call.id, conversationId: call.conversationId, name: call.displayName }} />;
}

/**
 * The player once there's audio, else what the recording is doing. A call nobody picked up has nothing to say
 * about a recording unless one was being captured or went wrong, so it gets no row (and no gap for one).
 */
function recordingRow(call: CallEntryInfo, answered: boolean) {
	const status = call.recording?.status;
	if (status === "ready") return <CallRecording key={`recording:${call.id}`} call={call} />;
	if (answered || status === "recording" || status === "processing" || status === "failed") return <RecordingStatus call={call} />;
	return null;
}

/** Where the recording is, while there's nothing to play yet: the player's bar, saying what it's waiting on. */
function RecordingStatus({ call }: { call: CallEntryInfo }) {
	const status = call.recording?.status;
	if (status === "recording" || status === "processing")
		return (
			<p role="status" className="flex h-11 items-center gap-2.5 rounded-xl bg-neutral-200/70 px-3.5 text-sm text-neutral-600">
				{status === "recording" ? <span aria-hidden="true" className="size-2 rounded-full bg-red-500 motion-safe:animate-pulse" /> : <SpinnerIcon className="animate-spin text-neutral-500" />}
				{status === "recording" ? "Recording this call…" : call.active ? "Preparing recording…" : "Saving recording…"}
			</p>
		);
	if (status === "failed")
		return (
			<p role="status" className="flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm break-words text-amber-800">
				<WarningIcon className="mt-0.5 shrink-0" /> {call.recording?.error || "The recording couldn't be saved."}
			</p>
		);
	return <p role="status" className="px-1 text-sm text-neutral-500">No recording for this call.</p>;
}

/** Asks the server to run a call's failed transcription or summary again. */
function useRetry(id: Id<"inboxMessages">) {
	const retry = useMutation(api.callRecordings.retry);
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState("");
	const run = async () => {
		setRetryError("");
		setRetrying(true);
		try { await retry({ id }); }
		catch (e) { setRetryError(errorMessage(e)); }
		finally { setRetrying(false); }
	};
	return { retrying, retryError, run };
}

/** What a call's transcript or summary says while it has no text: waiting, working, or what went wrong (with a way to try again). */
function NoteStatus({ id, tone, retry, children }: { id: Id<"inboxMessages">; tone: "quiet" | "busy" | "bad"; retry?: boolean; children: React.ReactNode }) {
	const { retrying, retryError, run } = useRetry(id);
	return (
		<div className="flex flex-col items-start gap-2 text-sm">
			<p role="status" className={`flex items-start gap-2 break-words ${tone === "bad" ? "text-amber-700" : "text-neutral-500"}`}>
				{tone === "busy" && <SpinnerIcon className="mt-0.5 shrink-0 animate-spin" />}
				{tone === "bad" && <WarningIcon className="mt-0.5 shrink-0" />}
				{children}
			</p>
			{retry && (
				<button type="button" className={smallButton} disabled={retrying} onClick={() => void run()}>
					<ReloadIcon /> {retrying ? "Retrying…" : "Try again"}
				</button>
			)}
			{retryError && <p role="alert" className="break-words text-red-600">{retryError}</p>}
		</div>
	);
}

type Turn = { speaker: string; text: string; start: number; end: number };
/** `turns` is null for a transcript saved before speakers were told apart. */
type Transcript = { text: string; turns: Turn[] | null };

/**
 * Who said what, one bubble per stretch of speech. The transcriber tells voices apart but not whose they are, so
 * they're "Speaker 1", "Speaker 2" in the order they first spoke, on alternating sides; nothing here names the
 * caller or the staff member. Without turns it's the plain text, said to be unseparated, never split by guesswork.
 */
function CallConversation({ transcript }: { transcript: Transcript }) {
	// One sentence can arrive in pieces; a speaker's consecutive pieces read as one bubble.
	const lines: Turn[] = [];
	for (const turn of transcript.turns ?? []) {
		const text = String(turn.text ?? "").trim();
		if (!text) continue;
		const last = lines[lines.length - 1];
		if (last?.speaker === turn.speaker) {
			last.text = `${last.text} ${text}`;
			last.end = turn.end;
		} else lines.push({ ...turn, text });
	}
	if (!lines.length) {
		const text = transcript.text.trim();
		if (!text) return <p className="text-sm text-neutral-500">No speech detected.</p>;
		return (
			<div className="flex flex-col gap-3">
				<p className="text-xs text-neutral-500">Speaker identification isn't available for this call.</p>
				<p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-neutral-700 select-text">{text}</p>
			</div>
		);
	}
	const speakers = [...new Set(lines.map((line) => line.speaker))];
	return (
		<ol className="flex flex-col gap-3">
			{lines.map((line, i) => {
				const speaker = speakers.indexOf(line.speaker);
				const right = speaker % 2 === 1;
				return (
					<li key={i} className={`flex flex-col gap-1 ${right ? "items-end" : "items-start"}`}>
						<p className="px-1 text-xs text-neutral-500 tabular-nums">
							Speaker {speaker + 1}
							{Number.isFinite(line.start) && line.start >= 0 && ` · ${clock(Math.floor(line.start))}`}
						</p>
						<p className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap select-text ${right ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-900"}`}>{line.text}</p>
					</li>
				);
			})}
		</ol>
	);
}

/** The transcript read is separate from the Inbox list, and shared by its preview and opened call. */
function useCallTranscript(call: CallEntryInfo, wanted: boolean) {
	const fetchTranscript = useAction(api.callRecordings.transcript);
	const ready = call.transcript?.status === "ready";
	const [request, setRequest] = useState(0);
	const [full, setFull] = useState<Transcript | null>(null);
	const [loadError, setLoadError] = useState("");
	useEffect(() => {
		if (!wanted || !ready) return;
		let ignore = false;
		setFull(null);
		setLoadError("");
		void fetchTranscript({ id: call.id }).then(
			(result) => { if (!ignore) setFull(result); },
			(e) => { if (!ignore) setLoadError(errorMessage(e)); },
		);
		return () => { ignore = true; };
	}, [call.id, wanted, request, ready, fetchTranscript]);
	return { full, loadError, reload: () => setRequest(n => n + 1) };
}

function TranscriptStatus({ call }: { call: CallEntryInfo }) {
	const transcript = call.transcript;
	if (!transcript) return <NoteStatus id={call.id} tone="quiet">No transcript for this call.</NoteStatus>;
	if (transcript.status === "failed") return <NoteStatus id={call.id} tone="bad" retry>{transcript.error || "The call couldn't be transcribed."}</NoteStatus>;
	if (transcript.status === "processing") return <NoteStatus id={call.id} tone="busy">Transcribing call…</NoteStatus>;
	return <NoteStatus id={call.id} tone="quiet">Waiting to transcribe the recording…</NoteStatus>;
}

function TranscriptLoading({ call, error, onReload }: { call: CallEntryInfo; error: string; onReload: () => void }) {
	if (!error) return <NoteStatus id={call.id} tone="busy">Loading transcript…</NoteStatus>;
	return (
		<div className="relative z-20 flex flex-col items-start gap-2">
			<NoteStatus id={call.id} tone="bad">{error}</NoteStatus>
			<button type="button" className={smallButton} onClick={onReload}><ReloadIcon /> Reload transcript</button>
		</div>
	);
}

/** The two-line excerpt beneath the player. Only older calls without an excerpt need a full read here. */
function CallTranscriptPreview({ call }: { call: CallEntryInfo }) {
	const { full, loadError, reload } = useCallTranscript(call, call.transcript?.preview === null);
	if (call.transcript?.status !== "ready") return <div className="relative z-20 px-1"><TranscriptStatus call={call} /></div>;
	const preview = call.transcript.preview ?? full?.text.replace(/\s+/g, " ").trim().slice(0, 320);
	if (preview === undefined) return <div className="px-1"><TranscriptLoading call={call} error={loadError} onReload={reload} /></div>;
	return preview ? <p className="line-clamp-2 px-1 text-sm leading-snug text-neutral-600 italic">{preview}</p> : null;
}

/** A call is an Inbox screen, using the same header, profile column and scrolling area as its conversation. */
export function CallDetail({ call, answeredBy, bar, side }: { call: CallEntryInfo; answeredBy?: string | null; bar: React.ReactNode; side: React.ReactNode }) {
	useTick(call.state === "connected");
	const { text, answered } = callStatus(call, answeredBy);
	const { full, loadError, reload } = useCallTranscript(call, true);
	const recording = recordingRow(call, answered);
	return (
		<Scroll
			overlayScrollbar
			header={bar}
			footer={recording && (
				<div className="flex">
					<div className={`${conversationColumn} min-w-0 flex-1 px-5 py-4`}>{recording}</div>
					{side && <div aria-hidden className="w-72 shrink-0" />}
				</div>
			)}
		>
			<div className="flex flex-1 items-start">
				<div className={`${conversationColumn} flex min-w-0 flex-1 flex-col gap-6 px-5 pt-5 pb-6`}>
					<div className="flex items-center gap-3">
						<CallIcon call={call} />
						<div className="min-w-0">
							<p className="font-semibold text-neutral-900">{call.direction === "in" ? "Incoming call" : "Outgoing call"}</p>
							<p className="text-sm text-neutral-500 tabular-nums">{text} · {dayLabel(call.startedAt)}, {timeOfDay(call.startedAt)}</p>
						</div>
					</div>
					{call.summary && <CallSummary call={call} />}
					<section aria-label="Transcript" className="flex min-w-0 flex-col gap-4">
						<p aria-hidden="true" className="text-xs font-medium text-neutral-500">Transcript</p>
						{call.transcript?.status !== "ready" ? <TranscriptStatus call={call} /> : full ? <CallConversation transcript={full} /> : <TranscriptLoading call={call} error={loadError} onReload={reload} />}
					</section>
				</div>
				{side && <aside className="sticky top-12 w-72 shrink-0 pr-3 pb-3">{side}</aside>}
			</div>
		</Scroll>
	);
}

/** A call's AI summary: its own block under the call, so it reads as a note about the call, not part of it. */
function CallSummary({ call }: { call: CallEntryInfo }) {
	const summary = call.summary!;
	const transcriptFailed = call.transcript?.status === "failed";
	return (
		<section aria-label="AI summary" className="flex flex-col gap-1.5 rounded-2xl border border-neutral-200 bg-white px-3 py-2.5">
			<p aria-hidden="true" className="flex items-center gap-1.5 text-xs font-medium text-neutral-500">
				<SparkleIcon /> AI summary
			</p>
			{summary.status === "ready" ? (
				<p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-neutral-700">{summary.text || "No summary available."}</p>
			) : summary.status === "processing" ? (
				<NoteStatus id={call.id} tone="busy">Writing summary…</NoteStatus>
			) : transcriptFailed ? (
				// The transcript's own failure, with Try again, is in the call above.
				<NoteStatus id={call.id} tone="quiet">A summary needs the transcript first.</NoteStatus>
			) : summary.status === "failed" ? (
				<NoteStatus id={call.id} tone="bad" retry>{summary.error || "The summary couldn't be generated."}</NoteStatus>
			) : (
				<NoteStatus id={call.id} tone="quiet">Summary will follow the transcript.</NoteStatus>
			)}
		</section>
	);
}

/** A call's outcome with its private recording and transcript, and the AI summary in its own block underneath. */
export function CallEntry({ call, answeredBy, onOpen }: { call: CallEntryInfo; answeredBy?: string | null; onOpen: () => void }) {
	useTick(call.state === "connected");
	const { text, answered } = callStatus(call, answeredBy);
	const recording = recordingRow(call, answered);
	return (
		// A record, not a bubble: a steady 70% of the conversation, never under 20rem until the column itself is narrower.
		<div className="flex w-[max(20rem,70%)] max-w-full flex-col gap-1.5">
			<div className="relative isolate flex flex-col gap-3 rounded-2xl bg-neutral-100 p-3">
				<button type="button" aria-label={`Open ${call.direction === "in" ? "incoming" : "outgoing"} call details`} data-call-open={call.id} className={callOpenButton} onClick={onOpen} />
				<div className="flex items-center gap-3">
					<CallIcon call={call} />
					<div className="min-w-0">
						<p className="font-semibold text-neutral-900">{call.direction === "in" ? "Incoming call" : "Outgoing call"}</p>
						<p className="truncate text-sm text-neutral-500 tabular-nums">{text}</p>
					</div>
				</div>
				{recording && <div className="relative z-20">{recording}</div>}
				{call.transcript && <CallTranscriptPreview key={`transcript:${call.id}`} call={call} />}
			</div>
			{call.summary && <CallSummary key={`summary:${call.id}`} call={call} />}
		</div>
	);
}
