import { useEffect, useState } from "react";
import type { DesktopBridge, UpdateStatus } from "../../preload/types";

declare global {
	interface Window {
		/** Set by the Electron preload. Missing when the UI runs in a plain browser. */
		companybot?: DesktopBridge;
	}
}

// The same app runs in the Electron shell and in a plain browser (the web build). Everything the
// shell adds goes through here, with what a browser does instead, so nothing else checks which.

/** The desktop shell, or undefined in a browser. */
export const desktop = (): DesktopBridge | undefined => window.companybot;

const title = "Companybot";

/** How many chats wait for you: the dock badge in the desktop app, the tab's title ("(3) Companybot") in a browser. 0 clears it. */
export function setBadge(count: number) {
	const app = desktop();
	if (app) return app.setBadge(count);
	document.title = count > 0 ? `(${count}) ${title}` : title;
}

/** Brings Companybot to the front, as clicking one of its notifications does. */
export function focusApp() {
	desktop()?.focus();
	window.focus();
}

/**
 * Opens a web link outside the app, never with a way back into this page: the default browser
 * from the desktop app (its main process routes every window.open there), a new tab in a browser.
 */
export function openLink(url: string) {
	window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Opens a link that's still on its way (a sign-in address from the server). A browser only opens
 * a tab during the click itself, so it opens an empty one at once and sends it there once the
 * address arrives, or closes it if there's none. The desktop app has no such limit.
 */
export async function openLinkWhenReady(url: Promise<string>) {
	if (desktop()) return openLink(await url);
	const tab = window.open("", "_blank");
	if (tab) tab.opener = null;
	try {
		const href = await url;
		if (tab) tab.location.href = href;
		else openLink(href);
	} catch (e) {
		tab?.close();
		throw e;
	}
}

/**
 * Asks to show notifications, if nobody has answered yet. The desktop app asks at once; a browser
 * ignores asks that don't come from a click or key press, so it waits for the first one. Returns a
 * function that stops waiting.
 */
export function askForNotifications(): () => void {
	if (typeof Notification === "undefined" || Notification.permission !== "default") return () => {};
	if (desktop()) {
		void Notification.requestPermission();
		return () => {};
	}
	const stop = () => {
		window.removeEventListener("pointerdown", ask, true);
		window.removeEventListener("keydown", ask, true);
	};
	const ask = () => {
		stop();
		if (Notification.permission === "default") void Notification.requestPermission();
	};
	window.addEventListener("pointerdown", ask, true);
	window.addEventListener("keydown", ask, true);
	return stop;
}

/** The app version and live update status, or nulls in a browser (it's always the latest there). */
export function useUpdates() {
	const [version, setVersion] = useState<string | null>(null);
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	useEffect(() => {
		const app = desktop();
		if (!app) return;
		void app.version().then(setVersion);
		void app.updates.status().then(setStatus);
		return app.updates.onStatus(setStatus);
	}, []);
	return { version, status };
}

export function describeUpdate(status: UpdateStatus): string {
	switch (status.state) {
		case "checking":
			return "Checking for updates…";
		case "current":
			return "You're up to date.";
		case "downloading":
			return `Downloading ${status.version}… ${Math.round(status.percent)}%`;
		case "ready":
			return `Version ${status.version} is ready. Restart to update.`;
		case "error":
			return "Couldn't check for updates. Try again later.";
		case "unsupported":
			return "Updates only run in the installed app.";
		default:
			return "";
	}
}
