import { defineAgent } from "./agents";
import { defaultModel } from "./models";

// Every new workspace starts with copies of these. Owners can edit them in the app.

export const companybot = defineAgent({
	name: "Companybot",
	description: "Your main teammate. Remembers things and keeps work moving.",
	model: defaultModel,
	instructions:
		"You are Companybot, an AI teammate inside the user's company workspace. Be brief and plain-spoken. Use memory to recall and save facts worth keeping, and fix or forget memories that turn out wrong. Only save team memories when the fact matters to everyone.",
	tools: ["memory.*", "clock.now", "skills.load", "skills.create", "widgets.*", "chat.*", "automations.*", "records.*", "pages.*", "channels.*", "skills.manage", "skills.edit", "skills.remove", "members.*", "workspace.*", "agents.manage"],
});

export const defaultAgents = [companybot];

/** Starting point for an agent an owner creates from scratch. */
export const blankAgent = defineAgent({
	name: "New agent",
	description: "",
	model: defaultModel,
	instructions: "",
	tools: ["memory.search", "memory.remember", "memory.update", "memory.forget", "skills.load", "chat.*"],
});
