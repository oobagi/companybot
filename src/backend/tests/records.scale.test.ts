import { setup as ownerAndMember, signIn } from "./helpers";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { legacyMemberOf } from "../convex/lib";
import { createRecord } from "../convex/recordOps";

// Lists over thousands of records, under real transaction limits. Slow (seeding takes about a
// minute), so `pnpm test` skips them; `pnpm test:scale` runs them, and CI runs both.

type As = Awaited<ReturnType<typeof signIn>>;
type List = FunctionReturnType<typeof api.records.list>;

async function setup() {
	const { t, owner, member } = await ownerAndMember();
	const task = (await owner.query(api.recordTypes.list)).find((t) => t.key === "task")!;
	return { t, owner, member, task };
}

describe("records: combined filters at scale", () => {
	type Seed = { name: string; status: string; owner: "a" | "b" | "c"; due?: string; tags?: string[] };

	/**
	 * 3,000 tasks, seeded once through recordOps so the index rows are the real ones. Odd ones are
	 * done and Dana's (a), even ones to do and Ben's (b), except four "rare" ones (i % 997 === 3),
	 * which are done and Ben's: the only records matching both, among 1,500 rows each. Carl (c)
	 * owns a few (i % 499 === 7). Due dates cycle over 28 days (none on every 50th); every 7th is tagged.
	 */
	const COUNT = 3000;
	let data: Promise<Awaited<ReturnType<typeof seed>>> | undefined;
	const seeded = () => (data ??= seed());
	async function seed() {
		const { t, owner, member, task } = await setup();
		await owner.mutation(api.workspace.invite, { email: "carl@co.com", role: "member" });
		const carl = await signIn(t, "carl@co.com");
		const users = { a: owner.userId, b: member.userId, c: carl.userId };
		await owner.mutation(api.fields.create, { typeId: task._id, label: "Tags", kind: "choice", multiple: true, options: [{ label: "x" }, { label: "y" }] });
		const seeds: Seed[] = Array.from({ length: COUNT }, (_, i) => {
			const rare = i % 997 === 3;
			return {
				name: `T${i}`,
				status: rare || i % 2 ? "done" : "to_do",
				owner: rare ? "b" : i % 499 === 7 ? "c" : i % 2 ? "a" : "b",
				...(i % 50 !== 0 && { due: `2026-01-${String(1 + (i % 28)).padStart(2, "0")}` }),
				...(i % 7 === 0 && { tags: i % 14 === 0 ? ["x", "y"] : ["y"] }),
			};
		});
		for (let start = 0; start < COUNT; start += 200) {
			await t.run(async (ctx) => {
				const who = { member: (await legacyMemberOf(ctx, owner.userId))! };
				for (const s of seeds.slice(start, start + 200))
					await createRecord(ctx, who, task._id, { name: s.name, status: s.status, assignee: users[s.owner], due: s.due, tags: s.tags });
			});
		}
		return { owner, task, users, seeds };
	}

	/** Newest first: the reverse of seeding order. */
	const newest = (seeds: Seed[], keep: (s: Seed) => boolean) => seeds.filter(keep).map((s) => s.name).reverse();
	/** By due date, then oldest first among equal dates. */
	const byDue = (seeds: Seed[], keep: (s: Seed) => boolean) =>
		seeds
			.map((s, i) => ({ ...s, i }))
			.filter((s) => s.due && keep(s))
			.sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : a.i - b.i))
			.map((s) => s.name);

	/** Every page until done. Each request runs under enforced transaction limits; no record may repeat. */
	async function all(as: As, args: Omit<FunctionArgs<typeof api.records.list>, "paginationOpts">, numItems: number) {
		const seen: string[] = [];
		let cursor: string | null = null;
		let requests = 0;
		let shortPages = 0;
		for (;;) {
			const result: List = await as.query(api.records.list, { ...args, paginationOpts: { numItems, cursor } });
			requests++;
			if (!result.isDone && result.page.length < numItems) shortPages++;
			seen.push(...result.page.map((r) => r.title));
			if (result.isDone) break;
			cursor = result.continueCursor;
		}
		expect(new Set(seen).size).toBe(seen.length);
		return { titles: seen, requests, shortPages };
	}

	it("finds a rare combination of common values, returning short pages within budget", { timeout: 600_000 }, async () => {
		const { owner, task, users, seeds } = await seeded();
		const expected = newest(seeds, (s) => s.status === "done" && s.owner === "b" && !!s.due);
		expect(expected.length).toBe(3);
		const got = await all(
			owner,
			{ typeId: task._id, filters: [{ field: "status", eq: "Done" }, { field: "assignee", eq: users.b }, { field: "due", empty: false }] },
			10,
		);
		expect(got.titles).toEqual(expected);
		// 1,500 rows per condition is more than one request reads, so it stops short and says to go on.
		expect(got.requests).toBeGreaterThan(1);
		expect(got.shortPages).toBeGreaterThan(0);
	});

	it("combines equality, a range and several owners across pages", { timeout: 600_000 }, async () => {
		const { owner, task, users, seeds } = await seeded();
		const expected = newest(seeds, (s) => s.status === "done" && s.owner !== "a" && !!s.due && s.due <= "2026-01-10");
		const got = await all(
			owner,
			{
				typeId: task._id,
				filters: [
					{ field: "status", eq: "done" },
					{ field: "assignee", in: [users.b, users.c] },
					{ field: "due", lte: "2026-01-10" },
				],
			},
			4,
		);
		expect(got.titles).toEqual(expected);
	});

	it("drives from the most selective condition", { timeout: 600_000 }, async () => {
		const { owner, task, users, seeds } = await seeded();
		const result = await owner.query(api.records.list, {
			typeId: task._id,
			filters: [{ field: "status", eq: "done" }, { field: "assignee", eq: users.c }],
			paginationOpts: { numItems: 50, cursor: null },
		});
		// Carl's few rows drive, so one request finishes it.
		expect(result.isDone).toBe(true);
		expect(result.page.map((r) => r.title)).toEqual(newest(seeds, (s) => s.status === "done" && s.owner === "c"));
	});

	it("sorts by one field while filtering by others", { timeout: 600_000 }, async () => {
		const { owner, task, users, seeds } = await seeded();
		const got = await all(
			owner,
			{
				typeId: task._id,
				filters: [{ field: "assignee", eq: users.c }, { field: "due", gte: "2026-01-05" }],
				sort: { field: "due", order: "asc" },
			},
			3,
		);
		expect(got.titles).toEqual(byDue(seeds, (s) => s.owner === "c" && s.due! >= "2026-01-05"));
		const desc = await all(owner, { typeId: task._id, filters: [{ field: "assignee", eq: users.c }], sort: { field: "due", order: "desc" } }, 2);
		expect(desc.titles).toEqual(byDue(seeds, (s) => s.owner === "c").reverse());
	});

	it("matches any of several values, and multi-value fields, without repeats", { timeout: 600_000 }, async () => {
		const { owner, task, users, seeds } = await seeded();
		const tagged = await all(owner, { typeId: task._id, filters: [{ field: "tags", in: ["x", "y"] }, { field: "assignee", eq: users.c }] }, 2);
		expect(tagged.titles).toEqual(newest(seeds, (s) => !!s.tags && s.owner === "c"));
		const x = await all(owner, { typeId: task._id, filters: [{ field: "status", in: ["to_do", "Done"] }, { field: "tags", eq: "x" }] }, 50);
		expect(x.titles).toEqual(newest(seeds, (s) => !!s.tags?.includes("x")));
	});

	it("filters by empty and not empty, and lists a lone range in its own order", { timeout: 600_000 }, async () => {
		const { owner, task, seeds } = await seeded();
		const noDue = await all(owner, { typeId: task._id, filters: [{ field: "due", empty: true }, { field: "status", eq: "to_do" }] }, 50);
		expect(noDue.titles).toEqual(newest(seeds, (s) => !s.due && s.status === "to_do"));
		const early = await all(owner, { typeId: task._id, filters: [{ field: "due", gte: "2026-01-02", lt: "2026-01-03" }] }, 50);
		expect(early.titles).toEqual(byDue(seeds, (s) => s.due! >= "2026-01-02" && s.due! < "2026-01-03"));
	});
});
