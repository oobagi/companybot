import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecordingControls, RecordingDock, RecordingPlaybackProvider } from "./RecordingPlayer";
import { useRoute } from "./router";
import { inApp } from "./testing";

const state = vi.hoisted(() => ({ available: true, playback: vi.fn() }));
vi.mock("./convex", () => ({ useAction: () => state.playback, useQuery: () => state.available }));
const target = { id: "call-one", conversationId: "conversation-one", name: "Sample caller" };
let root: Root;
let host: HTMLDivElement;
let audios: FakeAudio[];
class FakeAudio extends EventTarget {
	src = "";
	preload = "";
	currentTime = 0;
	duration = 30;
	paused = true;
	ended = false;
	constructor() { super(); audios.push(this); }
	play = vi.fn(async () => {
		this.paused = false;
		this.dispatchEvent(new Event("play"));
		this.dispatchEvent(new Event("playing"));
	});
	pause = vi.fn(() => {
		const wasPlaying = !this.paused;
		this.paused = true;
		if (wasPlaying) this.dispatchEvent(new Event("pause"));
	});
	load = vi.fn();
	removeAttribute(name: string) { if (name === "src") this.src = ""; }
}
function Pages() {
	const route = useRoute();
	return createElement("div", null,
		route[0] === "inbox" ? createElement(RecordingControls, { target }) : createElement("p", null, "Another screen"),
		createElement(RecordingDock),
	);
}
async function render({ enabled = true, interrupted = false, scope = "alice/workspace-one" } = {}) {
	await act(async () => root.render(inApp(createElement(StrictMode, null,
		createElement(RecordingPlaybackProvider, { key: scope, enabled, interrupted, children: createElement(Pages) }),
	))));
}
async function click(label: string) {
	const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
	expect(button).toBeTruthy();
	await act(async () => button!.click());
}
async function start() {
	await click("Play recording");
	await act(async () => audios[0]!.dispatchEvent(new Event("loadedmetadata")));
	expect(audios[0]!.paused).toBe(false);
}
async function route(hash: string) {
	await act(async () => { window.location.hash = hash; window.dispatchEvent(new Event("hashchange")); });
}
beforeEach(() => {
	audios = [];
	state.available = true;
	state.playback.mockReset().mockResolvedValue({ url: "https://private.example/test-recording" });
	vi.stubGlobal("Audio", FakeAudio);
	window.location.hash = "#/inbox/conversation-one/call/call-one";
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("keeps the same audio and position when navigating away and back, with shared controls", async () => {
	await render(); await start();
	const audio = audios[0]!;
	await act(async () => { audio.currentTime = 8.5; audio.dispatchEvent(new Event("timeupdate")); });
	await route("#/chat");
	expect(audios).toHaveLength(1);
	expect(audio.paused).toBe(false);
	expect(host.querySelector('[aria-label="Recording playback"]')).toBeTruthy();
	expect(host.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")).toBe("8");
	await click("Pause recording");
	expect(audio.paused).toBe(true);
	await route("#/inbox/conversation-one/call/call-one");
	expect(host.querySelector('[aria-label="Recording playback"]')).toBeNull();
	await click("Play recording");
	expect(audio.currentTime).toBe(8.5);
	expect(audio.paused).toBe(false);
	expect(state.playback).toHaveBeenCalledTimes(1);
	expect(audios).toHaveLength(1);
});

it("releases buffered audio on account or workspace change and on sign-out", async () => {
	await render(); await start();
	const audio = audios[0]!;
	await render({ scope: "alice/workspace-two" });
	expect(audio.paused).toBe(true);
	expect(audio.src).toBe("");
	await click("Play recording");
	await act(async () => audios[1]!.dispatchEvent(new Event("loadedmetadata")));
	await act(async () => root.render(createElement("div", null, "Signed out")));
	expect(audios[1]!.paused).toBe(true);
	expect(audios[1]!.src).toBe("");
});

it("releases already-buffered audio when the live access check is revoked", async () => {
	await render(); await start();
	state.available = false;
	await render();
	expect(audios[0]!.paused).toBe(true);
	expect(audios[0]!.src).toBe("");
	await route("#/chat");
	expect(host.querySelector('[aria-label="Recording playback"]')).toBeNull();
});

it("pauses for a ringing or live call and resumes only when the listener presses Play", async () => {
	await render(); await start();
	await render({ interrupted: true });
	expect(audios[0]!.paused).toBe(true);
	expect(host.querySelector<HTMLButtonElement>('[aria-label="Play recording"]')?.disabled).toBe(true);
	await render();
	expect(audios[0]!.paused).toBe(true);
	await click("Play recording");
	expect(audios[0]!.paused).toBe(false);
	expect(state.playback).toHaveBeenCalledTimes(1);
});
