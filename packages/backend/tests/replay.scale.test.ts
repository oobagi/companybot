import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentTurn, agentsOf, finishTurn, generalOf, newTest, signIn } from "./helpers";

afterEach(() => void vi.useRealTimers());

/** One kept step of about 960 KB, as the runner saves a long tool result. */
const bigStep = (i: number) => JSON.stringify([{ role: "assistant", content: `${i} ${"x".repeat(960_000)}` }]);

it("replays only the newest turns whose steps fit, dropping older ones whole", { timeout: 300_000 }, async () => {
	const t = newTest();
	const owner = await signIn(t, "owner@co.com");
	const general = (await generalOf(owner))._id;
	const { companybot } = await agentsOf(owner);
	// Six finished turns of three ~960 KB steps each: 18 steps, about 17 MB.
	for (let turn = 0; turn < 6; turn++) {
		const turnId: Id<"agentTurns"> = await agentTurn(t, owner, general, companybot._id);
		await finishTurn(t, turnId, `answer ${turn}`);
		await t.run(async (ctx) => {
			const row = (await ctx.db.get(turnId))!;
			// The prompt the runner stores before it calls the model.
			await ctx.db.patch(turnId, { prompt: `question ${turn}`, promptPlaces: [] });
			for (let i = 0; i < 3; i++) await ctx.db.insert("turnSteps", { workspaceId: row.workspaceId, turnId, actorId: row.actorId, messages: bigStep(i) });
		});
	}
	const turnId: Id<"agentTurns"> = await agentTurn(t, owner, general, companybot._id);
	const context = await t.mutation(internal.turns.turnContext, { turnId });
	// About 2.9 MB a turn against a 4 MiB budget: the newest fits, the rest are left out.
	expect(context.session.turns).toHaveLength(1);
	expect(context.session.turns[0]!.answer).toContain("answer 5");
	const sessionId = (await t.run((ctx) => ctx.db.get(turnId)))!.sessionId!;
	await finishTurn(t, turnId, "done");
	await expect(t.mutation(internal.turns.startCompaction, { sessionId })).resolves.not.toThrow();
});
