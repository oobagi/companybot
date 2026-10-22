import { useEffect, useState } from "react";
import type { DesktopBridge, UpdateStatus } from "../../preload/types";

declare global {
	interface Window {
		/** Set by the Electron preload. Missing when the UI runs in a plain browser. */
		companybot?: DesktopBridge;
	}
}

export const desktop = window.companybot;

/** The app version and live update status, or nulls in the browser preview. */
export function useUpdates() {
	const [version, setVersion] = useState<string | null>(null);
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	useEffect(() => {
		if (!desktop) return;
		void desktop.version().then(setVersion);
		void desktop.updates.status().then(setStatus);
		return desktop.updates.onStatus(setStatus);
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
			return `Couldn't check for updates: ${status.message}`;
		case "unsupported":
			return "Updates only run in the installed app.";
		default:
			return "";
	}
}
