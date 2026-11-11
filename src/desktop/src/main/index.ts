import { join } from "node:path";
import { BrowserWindow, app, ipcMain, shell } from "electron";
import { setUpUpdater } from "./updater";

function openOutside(url: string) {
	if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

function createWindow() {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 560,
		titleBarStyle: "hiddenInset",
		// Centred in the 32px title bar (h-8 in App.tsx).
		trafficLightPosition: { x: 12, y: 9 },
		backgroundColor: "#ffffff",
		show: false,
		webPreferences: { preload: join(import.meta.dirname, "../preload/index.cjs") },
	});
	win.once("ready-to-show", () => win.show());

	// Links go to the browser, never into the app window, and only web links at
	// that: a reply could contain any URL, and file: or app schemes stay shut.
	win.webContents.setWindowOpenHandler(({ url, frameName }) => {
		// The phone popped out (views/Phone.tsx): a blank window the app draws into, kept on top.
		if (frameName === "companybot-phone" && url === "about:blank")
			return {
				action: "allow",
				overrideBrowserWindowOptions: { width: 300, height: 560, minWidth: 280, minHeight: 440, title: "Phone", alwaysOnTop: true, fullscreenable: false, backgroundColor: "#ffffff", autoHideMenuBar: true },
			};
		openOutside(url);
		return { action: "deny" };
	});
	// The phone's window gets the same rules: links go to the browser, nothing navigates inside it.
	win.webContents.on("did-create-window", (child) => {
		child.webContents.setWindowOpenHandler(({ url }) => (openOutside(url), { action: "deny" }));
		child.webContents.on("will-navigate", (event, url) => (event.preventDefault(), openOutside(url)));
	});
	win.webContents.on("will-navigate", (event, url) => {
		event.preventDefault();
		openOutside(url);
	});

	if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
	else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
	setUpUpdater();
	ipcMain.on("app:badge", (_, count: number) => app.setBadgeCount(Math.max(0, Math.floor(count) || 0)));
	ipcMain.on("app:focus", (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (win?.isMinimized()) win.restore();
		win?.show();
		win?.focus();
	});
	createWindow();
	app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
