export type Role = "owner" | "member";

/** The person an agent is acting for. */
export interface Actor {
	userId: string;
	role: Role;
}

export class PermissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PermissionError";
	}
}
