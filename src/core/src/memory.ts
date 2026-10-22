import { type Actor, PermissionError } from "./types";

export type MemoryScope = "workspace" | "personal";

export interface Memory {
	id: string;
	scope: MemoryScope;
	/** Set for personal memories; null for workspace memories. */
	ownerId: string | null;
	content: string;
	updatedAt: string;
	updatedBy: string;
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

export interface MemoryStore {
	list(actor: Actor): Promise<Memory[]>;
	create(actor: Actor, input: { scope: MemoryScope; content: string }): Promise<Memory>;
	update(actor: Actor, id: string, content: string): Promise<Memory>;
	remove(actor: Actor, id: string): Promise<void>;
}

/** Process-local store. Swap for a database-backed store before shipping. */
export class InMemoryMemoryStore implements MemoryStore {
	private memories = new Map<string, Memory>();

	async list(actor: Actor) {
		return [...this.memories.values()].filter((m) => canReadMemory(actor, m));
	}

	async create(actor: Actor, { scope, content }: { scope: MemoryScope; content: string }) {
		if (!canCreateMemory(actor, scope)) {
			throw new PermissionError("Only owners can add workspace memories.");
		}
		const memory: Memory = {
			id: crypto.randomUUID(),
			scope,
			ownerId: scope === "personal" ? actor.userId : null,
			content,
			updatedAt: new Date().toISOString(),
			updatedBy: actor.userId,
		};
		this.memories.set(memory.id, memory);
		return memory;
	}

	async update(actor: Actor, id: string, content: string) {
		const memory = this.require(actor, id);
		if (!canEditMemory(actor, memory)) throw new PermissionError("You can't edit this memory.");
		const next = { ...memory, content, updatedAt: new Date().toISOString(), updatedBy: actor.userId };
		this.memories.set(id, next);
		return next;
	}

	async remove(actor: Actor, id: string) {
		const memory = this.require(actor, id);
		if (!canEditMemory(actor, memory)) throw new PermissionError("You can't delete this memory.");
		this.memories.delete(id);
	}

	private require(actor: Actor, id: string) {
		const memory = this.memories.get(id);
		// Hide memories the actor can't read, so their existence doesn't leak.
		if (!memory || !canReadMemory(actor, memory)) throw new Error(`Memory ${id} not found.`);
		return memory;
	}
}
