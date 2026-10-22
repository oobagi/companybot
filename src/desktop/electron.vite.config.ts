import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	// Bundle dependencies into the output so the packaged app needs no node_modules.
	main: { build: { externalizeDeps: false } },
	// Sandboxed preloads must be CommonJS.
	preload: {
		build: { externalizeDeps: false, rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
	},
	renderer: {
		// Read env from the repo-root .env.local (CONVEX_URL is written by `npx convex dev`).
		envDir: resolve(__dirname, "../.."),
		envPrefix: ["VITE_", "CONVEX_URL"],
		plugins: [react(), tailwindcss()],
	},
});
