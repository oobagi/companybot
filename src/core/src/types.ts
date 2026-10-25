export type Role = "owner" | "member";

/** The person an agent is acting for. */
export interface Actor {
	userId: string;
	role: Role;
}
