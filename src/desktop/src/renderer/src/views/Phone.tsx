import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatPhone } from "@companybot/core/inbox";
import type { FunctionReturnType } from "convex/server";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";
import { api } from "../api";
import { Select } from "../controls";
import { useAction, useMutation, useQuery } from "../convex";
import { PhoneIcon } from "../icons";
import { navigate } from "../router";
import { Form, Notice, compactButton, hintClass, labelButton, metadataClass, primaryButton, secondaryButton, wideControlClass } from "../ui";
import { DialogButtons, Modal } from "./chat/common";

type Target = { agentId?: Id<"agents">; to?: string; recordId?: Id<"records"> };
type Current = NonNullable<FunctionReturnType<typeof api.calls.current>>["calls"][number];
const PhoneContext = createContext<((target: Target) => void) | null>(null);

export function CallButton({ agentId, to, recordId, children = "Call" }: Target & { children?: React.ReactNode }) {
	const open = useContext(PhoneContext);
	const record = useQuery(api.calls.forRecord, open && !to && recordId ? { recordId } : "skip");
	if (!open) return null;
	return <button type="button" className={compactButton} onClick={() => open({ agentId, to: to ?? record?.phones[0] ?? "", recordId })}><PhoneIcon /> {children}</button>;
}

/** Above all routes, keyed to the workspace/account. Navigation never remounts the room or keypad. */
export function Phone({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
	const current = useQuery(api.calls.current, enabled ? {} : "skip");
	const numbers = useQuery(api.calls.numbers, enabled ? {} : "skip");
	const start = useMutation(api.calls.start);
	const join = useAction(api.phoneProvider.join);
	const ready = useMutation(api.calls.ready);
	const end = useMutation(api.calls.end);
	const decline = useMutation(api.calls.decline);
	const [target, setTarget] = useState<Target>();
	const [digits, setDigits] = useState("");
	const [agentId, setAgent] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [muted, setMuted] = useState(false);
	const [connected, setConnected] = useState(false);
	const audio = useRef<HTMLDivElement>(null);
	const session = useRef<{ room: Room; id: Id<"inboxMessages"> } | null>(null);
	const joining = useRef(false);
	const mounted = useRef(true);
	const mine = current?.calls.find((c) => c.mine);
	const incoming = current?.calls.find((c) => !c.mine);
	const leave = () => {
		const old = session.current;
		session.current = null;
		if (old) { old.room.removeAllListeners(); void old.room.disconnect(); }
		audio.current?.replaceChildren();
		if (mounted.current) { setConnected(false); setMuted(false); }
	};
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; const id = session.current?.id; leave(); if (id) void end({ id }).catch(() => {}); }; }, []);
	useEffect(() => { if (!enabled || current === null || (!mine && current !== undefined)) leave(); }, [enabled, current, mine?.id]);
	useEffect(() => {
		if (!incoming || mine) return;
		let context: AudioContext;
		try { context = new AudioContext(); } catch { return; }
		const ring = () => {
			if (context.state !== "running") return; // Browsers may require a prior gesture for audio.
			const tone = context.createOscillator();
			const gain = context.createGain();
			tone.frequency.value = 440; gain.gain.value = 0.05;
			tone.connect(gain); gain.connect(context.destination);
			tone.start(); tone.stop(context.currentTime + 0.25);
		};
		ring(); const timer = setInterval(ring, 2000);
		return () => { clearInterval(timer); void context.close(); };
	}, [incoming?.id, mine?.id]);
	// A provider disconnect also ends the server call. It must never keep billing after this tab lost audio.
	const connect = async (id: Id<"inboxMessages">) => {
		if (joining.current || session.current) return;
		joining.current = true; setBusy(true); setError("");
		let stream: MediaStream | undefined;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (!mounted.current) return;
			const credentials = await join({ id });
			if (!mounted.current) { void end({ id }); return; }
			const { Room, RoomEvent, Track, LocalAudioTrack } = await import("livekit-client");
			const room = new Room();
			session.current = { room, id };
			room.on(RoomEvent.TrackSubscribed, (track) => { if (track.kind === Track.Kind.Audio) audio.current?.append(track.attach()); });
			room.on(RoomEvent.TrackUnsubscribed, (track) => { track.detach().forEach((el) => el.remove()); });
			room.on(RoomEvent.Disconnected, () => { leave(); void end({ id }).catch(() => {}); });
			await room.connect(credentials.url, credentials.token);
			if (!mounted.current || session.current?.room !== room) { await room.disconnect(); return; }
			await room.localParticipant.publishTrack(new LocalAudioTrack(stream.getAudioTracks()[0]!), { source: Track.Source.Microphone });
			await ready({ id });
			setConnected(true); setTarget(undefined);
		} catch (e) {
			leave(); void end({ id }).catch(() => {});
			if (mounted.current) setError(e instanceof Error ? e.message : "Couldn't connect the call. Check microphone access.");
		} finally {
			// Published tracks are now owned by Room; failed or late microphone grants are always stopped.
			if (!session.current) stream?.getTracks().forEach((t) => t.stop());
			joining.current = false;
			if (mounted.current) setBusy(false);
		}
	};
	const place = async () => {
		if (busy) return;
		setBusy(true); setError("");
		try {
			const chosen = agentId || numbers?.[0]?.agentId;
			if (!chosen) throw new Error("Give an agent a phone number first.");
			const id = await start({ agentId: chosen as Id<"agents">, to: digits, ...(target?.recordId && { recordId: target.recordId }) });
			await connect(id);
		} catch (e) { setError(e instanceof Error ? e.message : "Couldn't start the call."); }
		finally { if (mounted.current) setBusy(false); }
	};
	const open = (t: Target) => { setTarget(t); if (t.to !== undefined) setDigits(t.to); else if (t.agentId || t.recordId) setDigits(""); if (t.agentId) setAgent(t.agentId); setError(""); };
	const tone = async (digit: string) => {
		if (mine?.state !== "connected") return;
		try { await session.current?.room.localParticipant.publishDtmf(digit === "*" ? 10 : digit === "#" ? 11 : Number(digit), digit); }
		catch { setError("Couldn't send the keypad tone."); }
	};
	return (
		<PhoneContext.Provider value={enabled ? open : null}>
			{children}
			<div ref={audio} className="hidden" />
			{enabled && <div className="fixed right-4 bottom-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-3 shadow-lg" aria-label="Phone">
				{error && <Notice>{error}</Notice>}
				{incoming && <div className="flex flex-wrap items-center gap-2" role="alert"><PhoneIcon /><span>Incoming: {formatPhone(incoming.contact)}</span><button type="button" className={compactButton} disabled={busy || !!mine} onClick={() => void connect(incoming.id)}>Accept</button><button type="button" className={compactButton} onClick={() => void decline({ id: incoming.id }).catch((e) => setError(String(e)))}>Decline</button></div>}
				{mine ? <div className="flex flex-wrap items-center gap-2">
					<button type="button" className={labelButton} onClick={() => navigate("inbox", mine.conversationId)}>{mine.name === mine.contact ? formatPhone(mine.contact) : mine.name}</button>
					<CallTime call={mine} />
					{connected ? <button type="button" className={compactButton} onClick={() => { const next = !muted; const room = session.current?.room; if (room) void room.localParticipant.setMicrophoneEnabled(!next).then(() => setMuted(next), () => setError("Couldn't change the microphone.")); }}>{muted ? "Unmute" : "Mute"}</button> : <button type="button" className={compactButton} disabled={busy || mine.state === "ending"} onClick={() => void connect(mine.id)}>Connect microphone</button>}
					<button type="button" className={compactButton} onClick={() => open({})}>Keypad</button>
					<button type="button" className={compactButton} onClick={() => { leave(); void end({ id: mine.id }).catch((e) => setError(String(e))); }}>Hang up</button>
					{connected && <button type="button" className={labelButton} onClick={() => void session.current?.room.startAudio()}>Enable audio</button>}
				</div> : <button type="button" className={labelButton} onClick={() => open({})}><PhoneIcon /> Keypad</button>}
			</div>}
			{target && <Modal title={connected ? "Keypad" : "Call"} onClose={() => setTarget(undefined)}><Form onSubmit={() => void place()}>
				{!connected && <><label className="flex flex-col gap-1 pb-3">From<Select label="From agent" className={wideControlClass} value={agentId || numbers?.[0]?.agentId || ""} options={(numbers ?? []).map((n) => ({ value: n.agentId, label: `${n.name} · ${formatPhone(n.number)}` }))} onChange={setAgent} /></label><input aria-label="Phone number" type="tel" autoFocus value={digits} onChange={(e) => setDigits(e.target.value)} className={wideControlClass} /></>}
				<div className="grid grid-cols-3 gap-2 py-3">{"123456789*0#".split("").map((d) => <button type="button" key={d} className={compactButton} disabled={!!mine && mine.state !== "connected"} onClick={() => connected ? void tone(d) : setDigits((s) => s + d)}>{d}</button>)}</div>
				<Notice>{error || (!current?.available ? "Calling isn't set up on this server." : "")}</Notice>
				<DialogButtons><button type="button" className={secondaryButton} onClick={() => setTarget(undefined)}>{connected ? "Close" : "Cancel"}</button>{!connected && <button type="submit" className={primaryButton} disabled={busy || !!mine || !current?.available || !digits.trim() || !numbers?.length}>Call</button>}</DialogButtons>
				<p className={`${hintClass} pt-3`}>Agent voice · Soon</p>
			</Form></Modal>}
		</PhoneContext.Provider>
	);
}

function CallTime({ call }: { call: Current }) {
	const [, tick] = useState(0);
	useEffect(() => { if (call.state !== "connected") return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [call.state]);
	const seconds = call.connectedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - call.connectedAt) / 1000));
	return <span className={metadataClass}>{call.state === "connected" ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : call.state === "ending" ? "Ending…" : "Ringing…"}</span>;
}

export function CallEntry({ call }: { call: { direction: string; state: string; connectedAt: number | null; endedAt: number | null } }) {
	const seconds = call.connectedAt === null ? 0 : Math.max(0, Math.round(((call.endedAt ?? Date.now()) - call.connectedAt) / 1000));
	return <div className="rounded-xl bg-neutral-100 p-3"><p className="flex items-center gap-2 font-medium"><PhoneIcon />{call.direction === "in" ? "Incoming call" : "Outgoing call"}</p><p className={metadataClass}>{call.state} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</p>{call.state === "unknown" && <p className={hintClass}>Outcome unknown. Check the phone log before calling again.</p>}<p className={`${hintClass} pt-2`}>Recording · Soon · Transcript · Soon · Summary · Soon</p></div>;
}
