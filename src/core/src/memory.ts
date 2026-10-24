import { can } from "./permissions";
import type { Actor } from "./types";

export type MemoryScope = "workspace" | "personal";

/** Each agent has its own memories. Scope decides who can see them. */
export interface Memory {
	id: string;
	agentId: string;
	scope: MemoryScope;
	/** Set for personal memories; null for workspace memories. */
	ownerId: string | null;
	content: string;
	updatedAt: string;
	updatedBy: string;
	/** True when the agent made the last change, acting for `updatedBy`. */
	updatedByAgent?: boolean;
	/** Goes up on every edit. Saves send the version they started from, so edits don't overwrite each other silently. */
	version: number;
}

// Team memories: everyone reads, only roles with "memory.team.write" change them.
// Personal memories: the person reads and edits their own; "memory.all.read" sees all.
export function canReadMemory(actor: Actor, memory: Memory): boolean {
	return memory.scope === "workspace" || memory.ownerId === actor.userId || can(actor, "memory.all.read");
}

export function canEditMemory(actor: Actor, memory: Memory): boolean {
	if (memory.scope === "workspace") return can(actor, "memory.team.write");
	return memory.ownerId === actor.userId || can(actor, "memory.all.read");
}

export function canCreateMemory(actor: Actor, scope: MemoryScope): boolean {
	return scope === "personal" || can(actor, "memory.team.write");
}

/**
 * One agent's memories, as seen by the person it's helping. Implementations must
 * enforce the rules above on every call; tools rely on that, not on their own checks.
 */
export interface MemoryStore {
	list(actor: Actor): Promise<Memory[]>;
	create(actor: Actor, input: { scope: MemoryScope; content: string }): Promise<Memory>;
	update(actor: Actor, id: string, content: string): Promise<Memory>;
	remove(actor: Actor, id: string): Promise<void>;
}
