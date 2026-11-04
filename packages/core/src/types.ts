export const roles = ["owner", "member"] as const;
export type Role = (typeof roles)[number];

/** The person an agent is acting for. */
export interface Actor {
	userId: string;
	role: Role;
}
