import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {},
	renderer: {
		// Read VITE_* vars from the repo-root .env.local.
		envDir: resolve(__dirname, "../.."),
		plugins: [react(), tailwindcss()],
	},
});
