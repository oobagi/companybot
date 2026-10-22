import { join } from "node:path";
import { BrowserWindow, app, shell } from "electron";

function createWindow() {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 560,
		titleBarStyle: "hiddenInset",
		backgroundColor: "#ffffff",
		show: false,
	});
	win.once("ready-to-show", () => win.show());

	// Open external links in the browser, not inside the app.
	win.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});

	if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
	else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
	createWindow();
	app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
