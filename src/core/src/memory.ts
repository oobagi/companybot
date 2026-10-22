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
	/** Goes up on every edit. Saves send the version they started from, so edits don't overwrite each other silently. */
	version: number;
}

// Owners can read and edit everything. Members read workspace memories and
// read/edit only their own personal memories.
export function canReadMemory(actor: Actor, memory: Memory): boolean {
	return actor.role === "owner" || memory.scope === "workspace" || memory.ownerId === actor.userId;
}

export function canEditMemory(actor: Actor, memory: Memory): boolean {
	return actor.role === "owner" || (memory.scope === "personal" && memory.ownerId === actor.userId);
}

export function canCreateMemory(actor: Actor, scope: MemoryScope): boolean {
	return scope === "personal" || actor.role === "owner";
}

/** One agent's memories, as seen by the person it's helping. */
export interface MemoryStore {
	list(actor: Actor): Promise<Memory[]>;
	create(actor: Actor, input: { scope: MemoryScope; content: string }): Promise<Memory>;
	update(actor: Actor, id: string, content: string): Promise<Memory>;
	remove(actor: Actor, id: string): Promise<void>;
}
