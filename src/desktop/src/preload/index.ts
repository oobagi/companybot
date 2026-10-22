import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, UpdateStatus } from "./types";

const bridge: DesktopBridge = {
	version: () => ipcRenderer.invoke("app:version"),
	updates: {
		status: () => ipcRenderer.invoke("updates:status"),
		check: () => ipcRenderer.invoke("updates:check"),
		install: () => ipcRenderer.invoke("updates:install"),
		onStatus(listener) {
			const handler = (_: unknown, status: UpdateStatus) => listener(status);
			ipcRenderer.on("updates:status", handler);
			return () => ipcRenderer.off("updates:status", handler);
		},
	},
};

contextBridge.exposeInMainWorld("companybot", bridge);
