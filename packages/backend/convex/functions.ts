import { customAction, customMutation, customQuery } from "convex-helpers/server/customFunctions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action as rawAction, mutation as rawMutation, query as rawQuery } from "./_generated/server";

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
