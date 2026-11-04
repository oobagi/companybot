// Runs the renderer in a plain browser, for quick UI checks without Electron.
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: resolve(__dirname, "src/renderer"),
	envDir: resolve(__dirname, "../.."),
	envPrefix: ["VITE_", "CONVEX_URL"],
	plugins: [react(), tailwindcss()],
});
