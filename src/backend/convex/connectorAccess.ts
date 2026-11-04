import type { Doc, Id } from "./_generated/dataModel";
import { type Member, UNSEEDED_MEMBER } from "./lib";

/** The role ids an install allows. Owners always can, so they're never listed. */
export function allowedRoles(member: Member, install: Doc<"connectorInstalls">): Id<"roles">[] {
	// COMPAT(0.1.0-alpha.10): installs list "owner"/"member" until migrations.customRolesConnectors
	// runs; read "member" as the Member role so nobody loses a connector mid-migration. Delete with it.
	const memberRole = member.workspaceRoles.find((r) => r.builtIn === "member")?.id;
	return install.roles.flatMap((r) => (r === "owner" ? [] : r === "member" ? (memberRole ? [memberRole] : member.workspaceRoles.length ? [] : [UNSEEDED_MEMBER]) : member.workspaceRoles.some((role) => role.id === r) ? [r] : []));
}
