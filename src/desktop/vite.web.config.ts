// The web build: the same renderer as the desktop app, in a plain browser. `dev:web` serves it,
// `build:web` writes a static site to dist-web/ (what Vercel hosts, vercel.json at the repo root).
// Like the desktop build, it reads CONVEX_URL from the repo root: .env.local when serving,
// .env.production (the prod backend) when building, unless CONVEX_URL is set in the environment.
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: resolve(import.meta.dirname, "src/renderer"),
	envDir: resolve(import.meta.dirname, "../.."),
	envPrefix: ["VITE_", "CONVEX_URL"],
	plugins: [react(), tailwindcss()],
	server: process.env.COMPANYBOT_DEV_PORT ? { host: "127.0.0.1", port: Number(process.env.COMPANYBOT_DEV_PORT), strictPort: true } : undefined,
	build: { outDir: resolve(import.meta.dirname, "dist-web"), emptyOutDir: true },
});
