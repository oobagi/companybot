import { expect, it } from "vitest";
import { limiter } from "./upload";

it("runs a few jobs at a time, in order, and a failure holds up nothing", async () => {
	const run = limiter(2);
	const started: string[] = [];
	const finish = new Map<string, () => void>();
	const job = (name: string, fail = false) => run(() => new Promise<string>((resolve, reject) => {
		started.push(name);
		finish.set(name, () => (fail ? reject(new Error(name)) : resolve(name)));
	}));
	const results = Promise.allSettled([job("a"), job("b", true), job("c"), job("d")]);
	await Promise.resolve();
	expect(started).toEqual(["a", "b"]);
	finish.get("b")!();
	await new Promise((r) => setTimeout(r, 0));
	expect(started).toEqual(["a", "b", "c"]);
	finish.get("a")!();
	await new Promise((r) => setTimeout(r, 0));
	expect(started).toEqual(["a", "b", "c", "d"]);
	finish.get("c")!();
	finish.get("d")!();
	expect((await results).map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
});
