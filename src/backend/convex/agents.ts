import { defaultAgents, describeToolAccess } from "@companybot/core";
import { query } from "./_generated/server";
import { getMember, toActor } from "./lib";

export const list = query({
	args: {},
	handler: async (ctx) => {
		const member = await getMember(ctx);
		if (!member) return [];
		return defaultAgents.map((agent) => ({
			id: agent.id,
			name: agent.name,
			description: agent.description,
			model: agent.model,
			tools: describeToolAccess(agent, toActor(member)),
		}));
	},
});
