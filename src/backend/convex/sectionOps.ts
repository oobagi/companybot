import { SECTIONS_MAX, type SectionTab, inboxStartSections } from "@companybot/core/arrangements";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// Sidebar sections people add (sidebarSections.ts): reads shared with the moves that take an item out.

/** A tab's sections in a workspace, oldest first (their shown order is the `sectionOrder` arrangement). */
export const sectionsOf = (ctx: QueryCtx, workspaceId: Id<"workspaces">, tab?: SectionTab) =>
	ctx.db.query("sidebarSections").withIndex("by_workspace", (q) => (tab ? q.eq("workspaceId", workspaceId).eq("tab", tab) : q.eq("workspaceId", workspaceId))).take(SECTIONS_MAX * 3);

/** Takes an item out of whichever of the tab's sections holds it: it moved somewhere sections don't list (a folder), or is gone. */
export async function leaveSections(ctx: MutationCtx, workspaceId: Id<"workspaces">, tab: SectionTab, id: string) {
	for (const section of await sectionsOf(ctx, workspaceId, tab)) {
		if (section.ids.includes(id)) await ctx.db.patch(section._id, { ids: section.ids.filter((k) => k !== id) });
	}
}


/** Inbox's first sections (core `inboxStartSections`), for a workspace whose Inbox has none yet. */
export async function startInboxSections(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
	if ((await sectionsOf(ctx, workspaceId, "inbox")).length) return;
	for (const s of inboxStartSections) await ctx.db.insert("sidebarSections", { workspaceId, tab: "inbox", name: s.name, ids: [...s.ids] });
}
