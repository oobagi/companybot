export type UpdateStatus =
	| { state: "idle" | "checking" | "unsupported" }
	| { state: "current"; checkedAt: number }
	| { state: "downloading"; version: string; percent: number }
	| { state: "ready"; version: string }
	| { state: "error" };

/** What the desktop shell exposes to the app as `window.companybot`. Absent in the web preview. */
export interface DesktopBridge {
	version(): Promise<string>;
	/** The dock (or taskbar) badge: unread DMs and mentions. 0 clears it. */
	setBadge(count: number): void;
	/** Brings the window to the front, e.g. when a notification is clicked. */
	focus(): void;
	updates: {
		status(): Promise<UpdateStatus>;
		check(): Promise<void>;
		/** Restarts into the downloaded version. Only does something when status is "ready". */
		install(): Promise<void>;
		onStatus(listener: (status: UpdateStatus) => void): () => void;
	};
}
