import { BrowserWindow, app, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateStatus } from "../preload/types";

const { autoUpdater } = electronUpdater;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

// Checks GitHub Releases (see `publish` in electron-builder.yml), downloads in the
// background, and tells the app when a restart will install the new version.

let status: UpdateStatus = { state: "idle" };

function setStatus(next: UpdateStatus) {
	status = next;
	for (const win of BrowserWindow.getAllWindows()) win.webContents.send("updates:status", status);
}

async function check() {
	// Dev builds have nothing to compare against.
	if (!app.isPackaged) return setStatus({ state: "unsupported" });
	if (status.state === "downloading" || status.state === "ready") return;
	try {
		await autoUpdater.checkForUpdates();
	} catch (e) {
		failed(e instanceof Error ? e : new Error(String(e)));
	}
}

// A release's tag is public a few minutes before CI uploads its files, so its
// latest-mac.yml 404s until then: nothing to install yet, not an error.
function failed(e: Error) {
	console.error("Update check failed:", e);
	if (/latest-mac\.yml[\s\S]*\b404\b/.test(e.message)) return setStatus({ state: "current", checkedAt: Date.now() });
	setStatus({ state: "error" });
}

export function setUpUpdater() {
	autoUpdater.autoDownload = true;
	autoUpdater.autoInstallOnAppQuit = true;

	autoUpdater.on("checking-for-update", () => setStatus({ state: "checking" }));
	autoUpdater.on("update-not-available", () => setStatus({ state: "current", checkedAt: Date.now() }));
	autoUpdater.on("update-available", (info) => setStatus({ state: "downloading", version: info.version, percent: 0 }));
	autoUpdater.on("download-progress", (p) =>
		setStatus({ state: "downloading", version: status.state === "downloading" ? status.version : "", percent: p.percent }),
	);
	autoUpdater.on("update-downloaded", (info) => setStatus({ state: "ready", version: info.version }));
	autoUpdater.on("error", failed);

	ipcMain.handle("app:version", () => app.getVersion());
	ipcMain.handle("updates:status", () => status);
	ipcMain.handle("updates:check", () => check());
	ipcMain.handle("updates:install", () => {
		if (status.state === "ready") autoUpdater.quitAndInstall();
	});

	void check();
	setInterval(() => void check(), CHECK_EVERY_MS).unref();
}
