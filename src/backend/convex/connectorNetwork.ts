"use node";

import { lookup } from "node:dns/promises";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";

// DNS for custom connectors' checked fetch (core `connectorFetch`): the agent runner and sign-in run
// in Convex's default runtime, which has no resolver. Node, like web.fetch's (webFetch.ts).

/** Every address `hostname` resolves to; none if it doesn't resolve. */
export const addresses = internalAction({
	args: { hostname: v.string() },
	handler: async (_ctx, { hostname }): Promise<string[]> => {
		try {
			return (await lookup(hostname, { all: true })).map((a) => a.address);
		} catch {
			return [];
		}
	},
});
