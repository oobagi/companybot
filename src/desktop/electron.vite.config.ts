import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {},
	renderer: {
		// Read env from the repo-root .env.local (CONVEX_URL is written by `npx convex dev`).
		envDir: resolve(__dirname, "../.."),
		envPrefix: ["VITE_", "CONVEX_URL"],
		plugins: [react(), tailwindcss()],
	},
});
