import type { AccessLevel, PlaceKind } from "./place-access";

// The Public role: anyone outside the workspace who reaches an agent (a texter, an emailer, later a
// caller or someone in website chat). They aren't members and never sign in, so the role applies by
// itself; it can't be given to anyone, edited into a staff role, or deleted.
//
// What Public may do is built from the same blocks as any role, with a hard ceiling in code:
// - Data access goes through places' Who can access lists (place-access.ts): an owner adds Public to a
//   page's or database's list like any role. The ceiling (`publicLevelProblem`) is View on pages, View or
//   Add on databases, and nothing on channels. Everyone never includes Public.
// - How it talks with them (whether replies go out right away, what it passes to staff) is each agent's
//   own setting (core agent-config.ts), not part of the role. Taking a message and handing off always work.
// Nothing else can ever be on: staff permissions (`permissions.ts`) aren't switches here, and a turn for an
// outsider never runs as a member, so it never reaches chat, memory, connectors, settings, members, roles,
// automations or money. Add an ability only if it's safe to hand to a stranger. wiki/permissions.md#public.

/**
 * The most Public can hold in each kind of place: never Edit, never a channel. Pages are shared one by
 * one (their sub-pages follow), so a Drive folder or file is never shared with Public.
 */
export const publicPlaceLevels: Record<PlaceKind, readonly AccessLevel[]> = { page: ["view"], database: ["view", "add"], channel: [], folder: [], file: [] };

/** Why Public can't have `level` in this kind of place, or null if it can. The only place-access rule just for Public. */
export function publicLevelProblem(kind: PlaceKind, level: AccessLevel): string | null {
	if (publicPlaceLevels[kind].includes(level)) return null;
	if (kind === "channel") return "Public can't be added to a channel: people outside the workspace never see chat.";
	if (kind === "folder" || kind === "file") return "Public can't be added to a folder or file: share the pages in it instead.";
	return kind === "page" ? "Public can only view pages." : "Public can only view or add to databases.";
}
