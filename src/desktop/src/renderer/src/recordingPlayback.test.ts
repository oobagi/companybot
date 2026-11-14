import { describe, expect, it, vi } from "vitest";
import { createRecordingPlayback, type RecordingTarget } from "./recordingPlayback";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

/** The media boundary: it emits actual events, and can finish a play request after its owner leaves. */
class AudioFake extends EventTarget {
	src = "";
	preload = "";
	duration = NaN;
	currentTime = 0;
	paused = true;
	ended = false;
	nextPlay: ReturnType<typeof deferred<void>> | undefined;
	play = vi.fn(() => {
		const next = this.nextPlay;
		this.nextPlay = undefined;
		const start = () => { this.paused = false; this.ended = false; this.emit("play"); this.emit("playing"); };
		if (next) return next.promise.then(start);
		start();
		return Promise.resolve();
	});
	pause = vi.fn(() => {
		if (this.paused) return;
		this.paused = true;
		this.emit("pause");
	});
	load = vi.fn();
	removeAttribute(name: string) { if (name === "src") this.src = ""; }
	emit(name: string) { this.dispatchEvent(new Event(name)); }
	metadata(duration = 30) { this.duration = duration; this.currentTime = 0; this.emit("loadedmetadata"); }
	at(time: number) { this.currentTime = time; this.emit("timeupdate"); }
}

const first: RecordingTarget = { id: "first", conversationId: "one", name: "First call" };
const second: RecordingTarget = { id: "second", conversationId: "two", name: "Second call" };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function setup() {
	const audios: AudioFake[] = [];
	const tickets: ReturnType<typeof deferred<{ url: string }>>[] = [];
	const playback = vi.fn(() => { const ticket = deferred<{ url: string }>(); tickets.push(ticket); return ticket.promise; });
	const controller = createRecordingPlayback({ createAudio: () => { const audio = new AudioFake(); audios.push(audio); return audio as unknown as HTMLAudioElement; }, playback });
	const start = async () => {
		controller.toggle(first);
		tickets[0]!.resolve({ url: "https://private/first" });
		await flush();
		audios[0]!.metadata();
		await flush();
		return audios[0]!;
	};
	return { controller, audios, tickets, playback, start };
}

describe("recording playback above the current route", () => {
	it("creates media on the first Play and keeps snapshots stable between changes", async () => {
		const { controller, audios, start } = setup();
		const before = controller.getSnapshot();
		expect(controller.getSnapshot()).toBe(before);
		expect(audios).toHaveLength(0);
		const changed = vi.fn();
		const unsubscribe = controller.subscribe(changed);
		const audio = await start();
		expect(controller.getSnapshot()).toMatchObject({ target: first, loaded: true, playing: true, busy: false, duration: 30 });
		const playing = controller.getSnapshot();
		audio.at(0);
		expect(controller.getSnapshot()).toBe(playing);
		expect(changed).toHaveBeenCalled();
		unsubscribe();
		changed.mockClear();
		audio.at(1);
		expect(changed).not.toHaveBeenCalled();
	});

	it("shares pause, resume and bounded seeking without reloading, and replays a finished recording", async () => {
		const { controller, playback, start } = setup();
		const audio = await start();
		audio.at(8);
		controller.toggle(first);
		expect(controller.getSnapshot()).toMatchObject({ playing: false, time: 8 });
		controller.toggle(first);
		await flush();
		expect(controller.getSnapshot().playing).toBe(true);
		expect(playback).toHaveBeenCalledTimes(1);
		controller.seek(90);
		expect(audio.currentTime).toBe(30);
		controller.seek(-4);
		expect(audio.currentTime).toBe(0);
		controller.seek(NaN);
		expect(controller.getSnapshot().time).toBe(0);
		audio.at(30); audio.ended = true; audio.paused = true; audio.emit("ended");
		controller.toggle(first);
		await flush();
		expect(controller.getSnapshot()).toMatchObject({ time: 0, playing: true });
		expect(playback).toHaveBeenCalledTimes(1);
	});

	it("ignores an old private-link response and old media events after another recording is selected", async () => {
		const { controller, tickets, audios } = setup();
		controller.toggle(first);
		controller.toggle(second);
		tickets[1]!.resolve({ url: "https://private/second" });
		await flush();
		audios[1]!.metadata(20);
		await flush();
		tickets[0]!.resolve({ url: "https://private/first" });
		audios[0]!.at(12); audios[0]!.emit("error");
		await flush();
		expect(audios[0]!.src).toBe("");
		expect(audios[1]!.src).toBe("https://private/second");
		expect(controller.getSnapshot()).toMatchObject({ target: second, time: 0, duration: 20, playing: true, error: "" });
	});

	it.each(["clear", "dispose"] as const)("%s prevents a late link from starting audio", async method => {
		const { controller, tickets, audios } = setup();
		controller.toggle(first);
		controller[method]();
		tickets[0]!.resolve({ url: "https://private/late" });
		await flush();
		audios[0]!.metadata();
		expect(audios[0]!.play).not.toHaveBeenCalled();
		expect(audios[0]!.src).toBe("");
		expect(controller.getSnapshot()).toMatchObject({ target: null, playing: false, busy: false, loaded: false });
	});

	it.each(["clear", "dispose"] as const)("%s stops a play promise that resolves after ownership is gone", async method => {
		const { controller, tickets, audios } = setup();
		controller.toggle(first);
		tickets[0]!.resolve({ url: "https://private/first" });
		await flush();
		const pending = deferred<void>();
		audios[0]!.nextPlay = pending;
		audios[0]!.metadata();
		controller[method]();
		pending.resolve();
		await flush();
		expect(audios[0]!.paused).toBe(true);
		expect(controller.getSnapshot()).toMatchObject({ target: null, busy: false, playing: false });
	});

	it("a late play completion from the previous recording cannot stop or replace the next one", async () => {
		const { controller, tickets, audios } = setup();
		controller.toggle(first);
		tickets[0]!.resolve({ url: "https://private/first" });
		await flush();
		const pending = deferred<void>(); audios[0]!.nextPlay = pending; audios[0]!.metadata();
		controller.toggle(second);
		tickets[1]!.resolve({ url: "https://private/second" });
		await flush();
		audios[1]!.metadata();
		await flush();
		pending.resolve();
		await flush();
		expect(audios[0]!.paused).toBe(true);
		expect(audios[1]!.paused).toBe(false);
		expect(controller.getSnapshot()).toMatchObject({ target: second, playing: true, error: "" });
	});

	it("clearing a playing or buffering recording releases its source and ignores later media events", async () => {
		const { controller, start } = setup();
		const audio = await start();
		audio.at(6); audio.emit("waiting");
		controller.clear();
		expect(audio.paused).toBe(true);
		expect(audio.src).toBe("");
		audio.at(9); audio.emit("playing"); audio.emit("error");
		expect(controller.getSnapshot()).toMatchObject({ target: null, time: 0, duration: 0, busy: false, playing: false });
	});

	it("an old Play completion cannot resume expired audio while its replacement link is pending", async () => {
		const { controller, tickets, audios } = setup();
		controller.toggle(first); tickets[0]!.resolve({ url: "https://private/first" }); await flush();
		const pending = deferred<void>(); audios[0]!.nextPlay = pending; audios[0]!.metadata();
		audios[0]!.at(6); audios[0]!.emit("error");
		pending.resolve(); await flush();
		expect(audios[0]!.paused).toBe(true);
		expect(controller.getSnapshot()).toMatchObject({ busy: true, loaded: false, playing: false, time: 6 });
	});

	it("Pause during the first load prevents metadata from starting it and Resume reuses that link", async () => {
		const { controller, tickets, audios, playback } = setup();
		controller.toggle(first);
		controller.toggle(first);
		tickets[0]!.resolve({ url: "https://private/first" });
		await flush();
		audios[0]!.metadata();
		expect(audios[0]!.play).not.toHaveBeenCalled();
		expect(controller.getSnapshot()).toMatchObject({ busy: false, playing: false, loaded: true });
		controller.toggle(first);
		await flush();
		expect(controller.getSnapshot().playing).toBe(true);
		expect(playback).toHaveBeenCalledTimes(1);
	});

	it("renews an expired private link at the same position, with Pause honored during recovery", async () => {
		const { controller, tickets, start, playback } = setup();
		const audio = await start();
		audio.at(8); audio.emit("error");
		expect(controller.getSnapshot()).toMatchObject({ time: 8, busy: true, loaded: false, playing: false });
		controller.pause();
		tickets[1]!.resolve({ url: "https://private/renewed" });
		await flush();
		audio.metadata();
		expect(controller.getSnapshot()).toMatchObject({ time: 8, busy: false, loaded: true, playing: false });
		controller.toggle(first);
		await flush();
		expect(controller.getSnapshot()).toMatchObject({ time: 8, playing: true });
		expect(playback).toHaveBeenCalledTimes(2);
	});

	it("does not keep renewing a failed replacement, and lets Play retry explicitly", async () => {
		const { controller, tickets, start, playback } = setup();
		const audio = await start();
		audio.at(7); audio.emit("error");
		tickets[1]!.resolve({ url: "https://private/failed-renewal" });
		await flush();
		audio.emit("error");
		expect(playback).toHaveBeenCalledTimes(2);
		expect(controller.getSnapshot()).toMatchObject({ loaded: false, busy: false, playing: false, time: 7 });
		expect(controller.getSnapshot().error).not.toBe("");
		controller.toggle(first);
		tickets[2]!.resolve({ url: "https://private/retried" });
		await flush(); audio.metadata(); await flush();
		expect(controller.getSnapshot()).toMatchObject({ loaded: true, playing: true, time: 7, error: "" });
	});

	it("shows a real rejected Play without getting stuck busy, and retries the loaded audio", async () => {
		const { controller, tickets, audios, playback } = setup();
		controller.toggle(first); tickets[0]!.resolve({ url: "https://private/first" }); await flush();
		const pending = deferred<void>(); audios[0]!.nextPlay = pending; audios[0]!.metadata();
		pending.reject(new Error("Sound needs another click.")); await flush();
		expect(controller.getSnapshot()).toMatchObject({ loaded: true, playing: false, busy: false, error: "Sound needs another click." });
		controller.toggle(first); await flush();
		expect(controller.getSnapshot()).toMatchObject({ playing: true, error: "", busy: false });
		expect(playback).toHaveBeenCalledTimes(1);
	});

	it("a cancelled play rejection cannot overwrite a later resume", async () => {
		const { controller, tickets, audios } = setup();
		controller.toggle(first); tickets[0]!.resolve({ url: "https://private/first" }); await flush();
		const pending = deferred<void>(); audios[0]!.nextPlay = pending; audios[0]!.metadata();
		controller.pause(); controller.toggle(first); await flush();
		pending.reject(new DOMException("Cancelled by pause", "AbortError")); await flush();
		expect(controller.getSnapshot()).toMatchObject({ playing: true, busy: false, error: "" });
	});
});
