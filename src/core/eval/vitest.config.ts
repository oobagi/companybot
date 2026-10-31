import { defineConfig } from "vitest/config";

// The reply-router eval (router.eval.ts): real model calls, so it's kept out of `pnpm test`.
export default defineConfig({ test: { include: ["eval/**/*.eval.ts"], testTimeout: 20 * 60_000 } });
