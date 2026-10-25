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

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Whether a memory matches a search: each query word starts one of its words, ignoring case
 * and punctuation ("aus" finds "Austin,"; "ustin" doesn't). An empty query matches all.
 */
export function memoryMatches(content: string, query: string) {
	const have = words(content);
	return words(query).every((w) => have.some((h) => h.startsWith(w)));
}

/**
 * One agent's memories, as seen by the person it's helping, in this chat. Implementations
 * must enforce the rules above on every call; tools rely on that, not on their own checks.
 */
export interface MemoryStore {
	/** Matching memories (`memoryMatches`) from the whole history, oldest first, capped. Empty query: the newest. */
	search(query: string): Promise<Memory[]>;
	create(input: { scope: MemoryScope; content: string }): Promise<Memory>;
	update(id: string, content: string): Promise<Memory>;
	remove(id: string): Promise<void>;
}
