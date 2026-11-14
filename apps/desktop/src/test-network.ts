import { beforeEach, vi } from "vitest";
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Outbound network disabled in tests")); });
