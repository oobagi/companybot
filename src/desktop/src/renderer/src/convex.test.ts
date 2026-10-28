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

// The core barrel pulls in the agent runtime (ai, zod); the app imports dependency-free modules by deep path.
// widgets.ts uses zod, so only its types may come in.
it("imports core by deep path, never the barrel", () => {
	const dir = join(import.meta.dirname);
	const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f));
	const bad = files.filter((f) => {
		const source = readFileSync(join(dir, f), "utf8");
		return /from "@companybot\/core"/.test(source) || /import (?!type )[^;]*from "@companybot\/core\/widgets"/.test(source);
	});
	expect(bad).toEqual([]);
});
