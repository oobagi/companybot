import { customAction, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import type { RegisteredMutation } from "convex/server";
import { type ObjectType, type PropertyValidators, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, action as rawAction, mutation as rawMutation, query as rawQuery } from "./_generated/server";
import { type Member, requireMember } from "./lib";

// Every public function the app calls is built with these instead of _generated/server's.
// Each takes the workspace the app has open (`workspaceId`, added to every call by the app's
// hooks) and puts it on ctx, where `getMember` reads it. The workspace always comes from the
// request, never from state another device could change. See wiki/architecture.md.

/** The workspace a request is for. Missing before one is open (ensure, mine): those act nowhere. */
export type Requested = { workspaceId: Id<"workspaces"> | undefined };

const args = { workspaceId: v.optional(v.id("workspaces")) };
const input = async (_ctx: unknown, { workspaceId }: { workspaceId?: Id<"workspaces"> }) => ({
	ctx: { workspaceId } satisfies Requested,
	args: {},
});

export const query = customQuery(rawQuery, { args, input });
export const mutation = customMutation(rawMutation, { args, input });
export const action = customAction(rawAction, { args, input });

/**
 * A public mutation that acts as the signed-in member: `fn(ctx, member, args)`. The same `fn`
 * serves agent tools, which call it with the member a turn acts for (manageTools.runFor).
 */
export const memberMutation = <Args extends PropertyValidators, Result>(
	args: Args,
	fn: (ctx: MutationCtx, member: Member, args: ObjectType<Args>) => Promise<Result>,
): RegisteredMutation<"public", ObjectType<Args> & Partial<Requested>, Promise<Result>> =>
	// The custom builder's generic handler type doesn't narrow for a generic `Args`; the declared return type is what callers see.
	mutation({ args, handler: async (ctx: MutationCtx, a: ObjectType<Args>) => fn(ctx, await requireMember(ctx), a) } as never) as never;
