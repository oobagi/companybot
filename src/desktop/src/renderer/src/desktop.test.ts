import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../../preload/types";
import { askForNotifications, focusApp, openLink, openLinkWhenReady, setBadge } from "./desktop";

// The same renderer runs in the desktop app (with the preload's `window.companybot`) and in a plain
// browser (without it). What the app does in each, through the same calls.

function fakeDesktop() {
	const bridge = { setBadge: vi.fn(), focus: vi.fn() } as unknown as DesktopBridge;
	window.companybot = bridge;
	return bridge;
}

/** The browser's notification permission, answered when asked. */
function fakeNotifications() {
	const fake = { permission: "default" as NotificationPermission, requestPermission: vi.fn(async () => (fake.permission = "granted")) };
	vi.stubGlobal("Notification", fake);
	return fake;
}

beforeEach(() => {
	delete window.companybot;
	document.title = "Companybot";
});
afterEach(() => {
	delete window.companybot;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("shows the unread count in the tab's title in a browser, and clears it at 0", () => {
	setBadge(3);
	expect(document.title).toBe("(3) Companybot");
	setBadge(0);
	expect(document.title).toBe("Companybot");
});

it("puts the unread count on the dock in the desktop app, leaving the title alone", () => {
	const app = fakeDesktop();
	setBadge(3);
	expect(app.setBadge).toHaveBeenCalledWith(3);
	expect(document.title).toBe("Companybot");
});

it("brings the window forward from a notification, with or without the desktop app", () => {
	const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
	focusApp();
	expect(focus).toHaveBeenCalled();
	const app = fakeDesktop();
	focusApp();
	expect(app.focus).toHaveBeenCalled();
});

it("asks for notifications on the first click in a browser, since a browser ignores asks out of nowhere", () => {
	const notifications = fakeNotifications();
	askForNotifications();
	expect(notifications.requestPermission).not.toHaveBeenCalled();
	window.dispatchEvent(new Event("pointerdown"));
	window.dispatchEvent(new Event("keydown"));
	expect(notifications.requestPermission).toHaveBeenCalledTimes(1);
});

it("stops waiting to ask once the app closes", () => {
	const notifications = fakeNotifications();
	askForNotifications()();
	window.dispatchEvent(new Event("pointerdown"));
	expect(notifications.requestPermission).not.toHaveBeenCalled();
});

it("asks at once in the desktop app, and never again once answered", () => {
	const notifications = fakeNotifications();
	fakeDesktop();
	askForNotifications();
	expect(notifications.requestPermission).toHaveBeenCalledTimes(1);
	notifications.permission = "denied";
	askForNotifications();
	delete window.companybot;
	askForNotifications();
	window.dispatchEvent(new Event("pointerdown"));
	expect(notifications.requestPermission).toHaveBeenCalledTimes(1);
});

it("opens links in a new tab that can't reach back into the app", () => {
	const open = vi.spyOn(window, "open").mockReturnValue(null);
	openLink("https://example.com");
	const [url, target, features] = open.mock.calls[0]!;
	expect(url).toBe("https://example.com");
	expect(target).toBe("_blank");
	expect(features).toContain("noopener");
});

it("opens a sign-in tab during the click and sends it on once the address arrives", async () => {
	const tab = { opener: {} as unknown, location: { href: "about:blank" }, close: vi.fn() };
	const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
	let arrive!: (url: string) => void;
	const opening = openLinkWhenReady(new Promise((resolve) => (arrive = resolve)));
	// Opened before the address came back, while the click still counts.
	expect(open).toHaveBeenCalledTimes(1);
	expect(tab.opener).toBeNull();
	arrive("https://accounts.example.com/authorize");
	await opening;
	expect(tab.location.href).toBe("https://accounts.example.com/authorize");
	expect(open).toHaveBeenCalledTimes(1);
});

it("closes the waiting tab when there's no address to send it to", async () => {
	const tab = { opener: null, location: { href: "about:blank" }, close: vi.fn() };
	vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
	await expect(openLinkWhenReady(Promise.reject(new Error("Not allowed")))).rejects.toThrow("Not allowed");
	expect(tab.close).toHaveBeenCalled();
});

it("opens the address once it arrives in the desktop app, with no empty window first", async () => {
	fakeDesktop();
	const open = vi.spyOn(window, "open").mockReturnValue(null);
	await openLinkWhenReady(Promise.resolve("https://accounts.example.com/authorize"));
	expect(open).toHaveBeenCalledTimes(1);
	expect(open.mock.calls[0]![0]).toBe("https://accounts.example.com/authorize");
});
