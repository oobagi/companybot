export type UpdateStatus =
	| { state: "idle" | "checking" | "unsupported" }
	| { state: "current"; checkedAt: number }
	| { state: "downloading"; version: string; percent: number }
	| { state: "ready"; version: string }
	| { state: "error"; message: string };

/** What the desktop shell exposes to the app as `window.companybot`. Absent in the web preview. */
export interface DesktopBridge {
	version(): Promise<string>;
	updates: {
		status(): Promise<UpdateStatus>;
		check(): Promise<void>;
		/** Restarts into the downloaded version. Only does something when status is "ready". */
		install(): Promise<void>;
		onStatus(listener: (status: UpdateStatus) => void): () => void;
	};
}
