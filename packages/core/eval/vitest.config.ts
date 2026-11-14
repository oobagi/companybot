import { defineConfig } from "vitest/config";

// The reply-router evals (router.eval.ts, full-path.eval.ts): real model calls, so they're kept out of `pnpm test`.
export default defineConfig({ test: { include: ["eval/**/*.eval.ts"], testTimeout: 20 * 60_000 } });
