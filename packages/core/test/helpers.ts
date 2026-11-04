import { skills } from "./fixtures";
import type { AutomationStore } from "../src/automation-tools";
import type { WakeupStore } from "../src/wakeups";
import type { PageStore } from "../src/page-tools";
import type { RecordStore } from "../src/record-tools";
import type { ChatStore } from "../src/chat";
import type { MemoryStore } from "../src/memory";
import type { SkillStore } from "../src/skills";

import { createResultStore } from "../src/tools";
import type { Actor } from "../src/types";
import type { WebTurn } from "../src/web";
import type { ImageStore } from "../src/image-tools";

export const owner: Actor = { userId: "owner", role: "owner" };
export const member: Actor = { userId: "member", role: "member" };
export const other: Actor = { userId: "other", role: "member" };

export const ctx = (actor: Actor) => ({
	actor,
	manage: { run: async () => { throw new Error("Unexpected management call"); } },
	agentId: "companybot",
	memory: {} as MemoryStore,
	chat: {} as ChatStore,
	skills: { list: skills } as SkillStore,
	results: createResultStore(),
	automations: {} as AutomationStore,
	wakeups: {} as WakeupStore,
	records: {} as RecordStore,
	pages: {} as PageStore,
	web: {} as WebTurn,
	images: {} as ImageStore,
});

