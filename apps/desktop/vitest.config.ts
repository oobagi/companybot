import { defineConfig } from "vitest/config";

// Tests for the renderer, on a stand-in page (happy-dom) for the parts that need one, like
// popovers and dialogs. Mantine is bundled so a test's mock of react-dom reaches its portals.
export default defineConfig({ test: { setupFiles: ["./src/test-network.ts"], include: ["src/**/*.test.ts"], environment: "happy-dom", server: { deps: { inline: [/@mantine\//] } } } });
