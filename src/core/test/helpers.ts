import type { AutomationStore } from "../src/automation-tools";
import type { RecordStore } from "../src/record-tools";
import type { ChatStore } from "../src/chat";
import type { MemoryStore } from "../src/memory";
import type { SkillStore } from "../src/skills";
import { skillCatalog } from "../src/skills";
import { createResultStore } from "../src/tools";
import type { Actor } from "../src/types";

export const owner: Actor = { userId: "owner", role: "owner" };
export const member: Actor = { userId: "member", role: "member" };
export const other: Actor = { userId: "other", role: "member" };

export const ctx = (actor: Actor) => ({
	actor,
	agentId: "companybot",
	memory: {} as MemoryStore,
	chat: {} as ChatStore,
	skills: { list: skillCatalog } as SkillStore,
	results: createResultStore(),
	automations: {} as AutomationStore,
	records: {} as RecordStore,
});

