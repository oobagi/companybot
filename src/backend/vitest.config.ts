import { configDefaults, defineConfig } from "vitest/config";

// Scale tests (*.scale.test.ts) take minutes, so they run on their own: `pnpm test:scale`.
const scale = !!process.env.SCALE;

export default defineConfig({
	test: {
		environment: "edge-runtime",
		server: { deps: { inline: ["convex-test"] } },
		...(scale ? { include: ["tests/**/*.scale.test.ts"] } : { exclude: [...configDefaults.exclude, "tests/**/*.scale.test.ts"] }),
	},
});
