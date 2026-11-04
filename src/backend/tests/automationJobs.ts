import { makeFunctionReference } from "convex/server";
import type { newTest } from "./helpers";

/** Execute only automation jobs; leave model turns parked so these tests never call inference. */
export async function automationJobs(t: ReturnType<typeof newTest>) {
	for (let i = 0; i < 10000; i++) {
		const job = await t.run(async ctx => {
			const jobs = await ctx.db.system.query("_scheduled_functions").collect();
			const job = jobs.find(j => j.state.kind === "pending" && j.name.startsWith("automationRuns:"));
			if (job) await ctx.scheduler.cancel(job._id);
			return job;
		});
		if (!job) return;
		await t.mutation(makeFunctionReference<"mutation">(job.name), job.args[0]);
	}
	throw new Error("Automation jobs did not finish");
}
