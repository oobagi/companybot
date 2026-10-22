import type { z } from "zod";
import type { MemoryStore } from "./memory";
import type { Skill } from "./skills";
import type { Actor, Role } from "./types";

/** What a tool can reach while it runs. */
export interface ToolContext {
	actor: Actor;
	agentId: string;
	memory: MemoryStore;
	/** Skills installed in the workspace. */
	skills: Skill[];
}

/** A built-in tool. Id is "group.name", e.g. "memory.search". */
export interface ToolDef<Input = any> {
	id: string;
	description: string;
	input: z.ZodType<Input>;
	/** Roles allowed to use this tool. Omit for everyone. */
	roles?: Role[];
	execute(input: Input, ctx: ToolContext): Promise<unknown>;
}

export const defineTool = <Input>(tool: ToolDef<Input>) => tool;
