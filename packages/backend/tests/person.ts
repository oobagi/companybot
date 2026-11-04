import type { convexTest } from "convex-test";
import { type FunctionArgs, type FunctionReference, type FunctionReturnType, getFunctionName } from "convex/server";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type Identity = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
type Fn = FunctionReference<"query" | "mutation" | "action">;
/** A public function's own args: every one also takes the app's `workspaceId` (convex/functions.ts). */
type Own<F extends Fn> = Omit<FunctionArgs<F>, "workspaceId">;
type Rest<F extends Fn> = keyof Own<F> extends never ? [args?: Own<F>] : [args: Own<F>];

/**
 * A signed-in person's calls. With `workspaceId`, each carries it, as the app does; without,
 * they name none, as before a workspace is open: only workspace-free calls (ensure, mine) work.
 *
 * A message they send to an agent (its DM, an @mention) has its quiet window (core QUIET_WINDOW_MS)
 * ended at once, as its timer would, so tests see its turn start as before. `debounced()` leaves it to
 * the timer, for tests of bursts.
 */
export function person(identity: Identity, workspaceId?: Id<"workspaces">, { debounce = false } = {}) {
	const withWorkspace = (args: object | undefined) => ({ ...args, ...(workspaceId && { workspaceId }) }) as never;
	const endQuietWindow = async (messageId: Id<"chatMessages">) => {
		const turns = await identity.run((ctx) => ctx.db.query("agentTurns").filter((q) => q.eq(q.field("triggerId"), messageId)).collect());
		for (const turn of turns) if (turn.debouncing) await identity.mutation(internal.turns.startQueued, { turnId: turn._id });
	};
	return {
		query: <Q extends FunctionReference<"query">>(fn: Q, ...[args]: Rest<Q>) =>
			identity.query(fn as FunctionReference<"query">, withWorkspace(args)) as Promise<FunctionReturnType<Q>>,
		mutation: async <M extends FunctionReference<"mutation">>(fn: M, ...[args]: Rest<M>) => {
			const out = await identity.mutation(fn as FunctionReference<"mutation">, withWorkspace(args));
			if (!debounce && getFunctionName(fn) === "messages:send") await endQuietWindow(out as Id<"chatMessages">);
			return out as FunctionReturnType<M>;
		},
		action: <A extends FunctionReference<"action">>(fn: A, ...[args]: Rest<A>) =>
			identity.action(fn as FunctionReference<"action">, withWorkspace(args)) as Promise<FunctionReturnType<A>>,
		/** An HTTP request to the backend's site, signed in as them. */
		fetch: (path: string, init?: RequestInit) => identity.fetch(path, init),
		/** The same person, with a window that has `id` open. */
		in: (id: Id<"workspaces">) => person(identity, id, { debounce }),
		/** The same person, whose messages wait out their quiet window on the timer, as in the app. */
		debounced: () => person(identity, workspaceId, { debounce: true }),
	};
}
