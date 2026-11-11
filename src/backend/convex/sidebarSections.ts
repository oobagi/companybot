import { SECTIONS_MAX, SECTION_ITEMS_MAX, SECTION_NAME_MAX, applyCommand, sectionTabs } from "@companybot/core/arrangements";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { changeArrangement, viewer } from "./arrangements";
import { fileReach, fileRow } from "./driveFiles";
import { mutation, query } from "./functions";
import { type Member, checkPermission, getMember, requireInWorkspace, requireMember } from "./lib";
import { pageReach } from "./pageOps";
import { hasChildren, pageRow } from "./pageTree";
import { sectionTab } from "./schema";
import { sectionsOf } from "./sectionOps";

// Sections people add to Chat's, Drive's and Databases' sidebars, like Discord's categories: one layout
// for the workspace, changed by people whose role has `sidebar.arrange`; anyone folds them (`folded`).
// A section holds its tab's things (channels; top-level pages, folders and files; databases) in order,
// each in one section at most; the rest stay where they were, in the tab's own list (core `sectionTabs`).
// `arrangements.get` hands them to the app, cut to what each person sees. See wiki/architecture.md.

async function requireSection(ctx: MutationCtx, member: Member, sectionId: Id<"sidebarSections">) {
	checkPermission(member, "sidebar.arrange");
	return requireInWorkspace(member, await ctx.db.get(sectionId), "Section");
}

function cleanName(name: string) {
	const clean = name.replace(/\s+/g, " ").trim();
	if (!clean) throw new ConvexError("Give the section a name.");
	if (clean.length > SECTION_NAME_MAX) throw new ConvexError(`Keep section names under ${SECTION_NAME_MAX} characters.`);
	return clean;
}

/** A new, empty section at the end of the tab's. */
export const create = mutation({
	args: { tab: sectionTab, name: v.string() },
	handler: async (ctx, { tab, name }) => {
		const member = checkPermission(await requireMember(ctx), "sidebar.arrange");
		if ((await sectionsOf(ctx, member.workspaceId, tab)).length >= SECTIONS_MAX) throw new ConvexError(`A sidebar can have ${SECTIONS_MAX} sections.`);
		return ctx.db.insert("sidebarSections", { workspaceId: member.workspaceId, tab, name: cleanName(name), ids: [] });
	},
});

export const rename = mutation({
	args: { sectionId: v.id("sidebarSections"), name: v.string() },
	handler: async (ctx, { sectionId, name }) => {
		const section = await requireSection(ctx, await requireMember(ctx), sectionId);
		await ctx.db.patch(section._id, { name: cleanName(name) });
	},
});

/** Deletes a section. What it held goes back where its tab keeps things in no section. */
export const remove = mutation({
	args: { sectionId: v.id("sidebarSections") },
	handler: async (ctx, { sectionId }) => {
		const member = await requireMember(ctx);
		const section = await requireSection(ctx, member, sectionId);
		await ctx.db.delete(section._id);
		const order = await ctx.db.query("arrangements").withIndex("by_list", (q) => q.eq("workspaceId", member.workspaceId).eq("userId", undefined).eq("list", "sectionOrder").eq("entityId", undefined)).unique();
		if (order?.ids.includes(sectionId)) await ctx.db.patch(order._id, { ids: order.ids.filter((id) => id !== sectionId) });
	},
});

/**
 * Puts one of a tab's things in a section, before `beforeId` (last when null), or with `sectionId`
 * null back among the things in none, in that list's order (`fill`: ids shown there but never saved,
 * as in `arrangements.change`). It leaves whichever section held it, so it's only ever in one. Drive's
 * files in no section go by name, and Inbox's conversations aren't listed outside one: they just leave their section.
 */
export const place = mutation({
	args: { tab: sectionTab, id: v.string(), sectionId: v.union(v.id("sidebarSections"), v.null()), beforeId: v.union(v.string(), v.null()), fill: v.optional(v.array(v.string())) },
	handler: async (ctx, { tab, id, sectionId, beforeId, fill }) => {
		const member = checkPermission(await requireMember(ctx), "sidebar.arrange");
		const seen = viewer(ctx, member);
		// Hidden things can't be moved or used as an anchor, the same as a missing one.
		for (const named of beforeId === null ? [id] : [id, beforeId]) if (!(await seen.sectionItem(tab, named))) throw new ConvexError("Not found.");
		const sections = await sectionsOf(ctx, member.workspaceId, tab);
		const target = sectionId && sections.find((s) => s._id === sectionId);
		if (sectionId && !target) throw new ConvexError("Section not found.");
		for (const s of sections) if (s !== target && s.ids.includes(id)) await ctx.db.patch(s._id, { ids: s.ids.filter((k) => k !== id) });
		if (target) {
			const ids = applyCommand(target.ids, { op: "move", id, beforeId });
			if (ids.length > SECTION_ITEMS_MAX) throw new ConvexError(`A section can hold ${SECTION_ITEMS_MAX} things.`);
			await ctx.db.patch(target._id, { ids });
		} else if ((tab !== "drive" || ctx.db.normalizeId("pages", id)) && !(tab === "inbox" && ctx.db.normalizeId("inboxConversations", id))) {
			await changeArrangement(ctx, member, { list: sectionTabs[tab] }, { op: "move", id, beforeId, fill }, seen);
		}
	},
});

/** A Drive section's pages, folders and files as the sidebar's tree shows them, in no order (`Section.ids` is it). */
export const driveRows = query({
	args: { sectionId: v.id("sidebarSections") },
	handler: async (ctx, { sectionId }) => {
		const member = await getMember(ctx);
		const section = member && (await ctx.db.get(sectionId));
		const rows = { pages: [] as (ReturnType<typeof pageRow> & { hasChildren: boolean })[], files: [] as ReturnType<typeof fileRow>[] };
		if (!member || section?.workspaceId !== member.workspaceId || section.tab !== "drive") return rows;
		const pageLevel = pageReach(ctx, member);
		const fileLevel = fileReach(ctx, member);
		const top = <T extends Doc<"pages"> | Doc<"driveFiles">>(doc: T | null): doc is T => !!doc && doc.workspaceId === member.workspaceId && !doc.archived && !doc.parentId;
		for (const id of section.ids.slice(0, SECTION_ITEMS_MAX)) {
			const pageId = ctx.db.normalizeId("pages", id);
			const fileId = ctx.db.normalizeId("driveFiles", id);
			if (pageId) {
				const page = await ctx.db.get(pageId);
				const level = top(page) && !page.recordId && (await pageLevel(page));
				if (level) rows.pages.push({ ...pageRow(page, member, level), hasChildren: await hasChildren(ctx, page) });
			} else if (fileId) {
				const file = await ctx.db.get(fileId);
				const level = top(file) && (await fileLevel(file));
				if (level) rows.files.push(fileRow(file, member, level));
			}
		}
		return rows;
	},
});
