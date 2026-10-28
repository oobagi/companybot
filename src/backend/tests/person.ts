import type { convexTest } from "convex-test";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";

type Identity = ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
type Fn = FunctionReference<"query" | "mutation" | "action">;
/** A public function's own args: every one also takes the app's `workspaceId` (convex/functions.ts). */
type Own<F extends Fn> = Omit<FunctionArgs<F>, "workspaceId">;
type Rest<F extends Fn> = keyof Own<F> extends never ? [args?: Own<F>] : [args: Own<F>];

/**
 * A signed-in person's calls. With `workspaceId`, each carries it, as the app does; without,
 * they name none, as before a workspace is open: only workspace-free calls (ensure, mine) work.
 */
export function person(identity: Identity, workspaceId?: Id<"workspaces">) {
	const withWorkspace = (args: object | undefined) => ({ ...args, ...(workspaceId && { workspaceId }) }) as never;
	return {
		query: <Q extends FunctionReference<"query">>(fn: Q, ...[args]: Rest<Q>) =>
			identity.query(fn as FunctionReference<"query">, withWorkspace(args)) as Promise<FunctionReturnType<Q>>,
		mutation: <M extends FunctionReference<"mutation">>(fn: M, ...[args]: Rest<M>) =>
			identity.mutation(fn as FunctionReference<"mutation">, withWorkspace(args)) as Promise<FunctionReturnType<M>>,
		action: <A extends FunctionReference<"action">>(fn: A, ...[args]: Rest<A>) =>
			identity.action(fn as FunctionReference<"action">, withWorkspace(args)) as Promise<FunctionReturnType<A>>,
		/** An HTTP request to the backend's site, signed in as them. */
		fetch: (path: string, init?: RequestInit) => identity.fetch(path, init),
		/** The same person, with a window that has `id` open. */
		in: (id: Id<"workspaces">) => person(identity, id),
	};
}
