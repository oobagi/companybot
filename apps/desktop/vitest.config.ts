import { defineConfig } from "vitest/config";

// Unit tests for the renderer's pure logic (no DOM).
export default defineConfig({ test: { include: ["src/**/*.test.ts"] } });
