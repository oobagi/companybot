import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useQuery as useCachedQuery, usePaginatedQuery as useCachedPaginatedQuery } from "convex-helpers/react/cache";
import type { OptimisticUpdate } from "convex/browser";
import { type PaginatedQueryReference, useAction as useConvexAction, useConvex, useMutation as useConvexMutation } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { createContext, useCallback, useContext, useRef } from "react";

// The app's Convex hooks. Use these, not convex/react's: each call carries the workspace this
// window has open, so a request always acts where it was made, whatever another device opened
// (backend functions.ts). Outside a workspace (sign-in, the workspace picker) they send none.

/** The workspace this window has open, and how to open another (App.tsx): false if you're not in it. */
export type OpenWorkspace = { id: Id<"workspaces">; open: (id: Id<"workspaces">) => boolean };
export const WorkspaceContext = createContext<OpenWorkspace | null>(null);

export const useWorkspace = () => useContext(WorkspaceContext);

type Args = Record<string, unknown> | undefined;
/** A function's own args: the hooks add `workspaceId`. Optional when it takes nothing else. */
type Own<F extends FunctionReference<"query" | "mutation" | "action">> = Omit<FunctionArgs<F>, "workspaceId">;
type Rest<F extends FunctionReference<"query" | "mutation" | "action">, Extra = never> = keyof Own<F> extends never
	? [args?: Own<F> | Extra]
	: [args: Own<F> | Extra];
const withWorkspace = <A extends Args>(args: A, workspaceId: Id<"workspaces"> | null) =>
	(workspaceId ? { ...args, workspaceId } : (args ?? {})) as never;

export function useQuery<Q extends FunctionReference<"query">>(query: Q, ...[args]: Rest<Q, "skip">): FunctionReturnType<Q> | undefined {
	const workspaceId = useContext(WorkspaceContext)?.id ?? null;
	return useCachedQuery(query as FunctionReference<"query">, args === "skip" ? "skip" : withWorkspace(args as Args, workspaceId));
}

export function usePaginatedQuery<Q extends PaginatedQueryReference>(
	query: Q,
	args: Parameters<typeof useCachedPaginatedQuery<Q>>[1],
	options: Parameters<typeof useCachedPaginatedQuery<Q>>[2],
) {
	const workspaceId = useContext(WorkspaceContext)?.id ?? null;
	return useCachedPaginatedQuery(query, args === "skip" ? "skip" : withWorkspace(args as Args, workspaceId), options);
}

/**
 * A query's last result while new args load (`useQuery` gives undefined until then), so a list
 * keeps showing instead of flashing empty. Undefined only before the first result.
 */
export function useSettled<T>(value: T | undefined): T | undefined {
	const last = useRef(value);
	if (value !== undefined) last.current = value;
	return last.current;
}

// Stable between renders (like convex/react's), so effects can depend on them.

/** A query asked once rather than watched (a menu's search as you type). */
export function useQueryOnce<Q extends FunctionReference<"query">>(query: Q) {
	const workspaceId = useContext(WorkspaceContext)?.id ?? null;
	const client = useConvex();
	return useCallback((...[args]: Rest<Q>): Promise<FunctionReturnType<Q>> => client.query(query, withWorkspace(args as Args, workspaceId)), [client, query, workspaceId]);
}

/**
 * `optimistic` makes the update that changes cached query results until the server's arrive; its args
 * include `workspaceId`. It's called once per call, before Convex can replay the update, so per-call
 * state (a temporary id) stays fixed. Define it outside the component, or the mutation changes every render.
 */
export function useMutation<M extends FunctionReference<"mutation">>(mutation: M, optimistic?: () => OptimisticUpdate<FunctionArgs<M>>) {
	const workspaceId = useContext(WorkspaceContext)?.id ?? null;
	const plain = useConvexMutation(mutation);

	return useCallback(
		(...[args]: Rest<M>): Promise<FunctionReturnType<M>> => (optimistic ? plain.withOptimisticUpdate(optimistic()) : plain)(withWorkspace(args as Args, workspaceId)),
		[plain, optimistic, workspaceId],
	);
}

export function useAction<A extends FunctionReference<"action">>(action: A) {
	const workspaceId = useContext(WorkspaceContext)?.id ?? null;
	const run = useConvexAction(action);
	return useCallback(
		(...[args]: Rest<A>): Promise<FunctionReturnType<A>> => run(withWorkspace(args as Args, workspaceId)),
		[run, workspaceId],
	);
}
