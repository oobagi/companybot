import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Every call must carry the open workspace, so screens use ./convex's hooks, never the raw ones.
it("routes every Convex call through the workspace-aware hooks", () => {
	const dir = join(import.meta.dirname);
	const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f) && f !== "convex.ts");
	const raw = files.filter((f) =>
		/import \{[^}]*\b(useQuery|useMutation|useAction|usePaginatedQuery)\b[^}]*\} from "convex(\/react|-helpers\/react\/cache)"/.test(
			readFileSync(join(dir, f), "utf8"),
		),
	);
	expect(raw).toEqual([]);
});
