import type { SectionTab } from "@companybot/core/arrangements";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { type As, generalOf, ownerAndMember, setMemberSwitch, settle, upload, workspaceOf } from "./helpers";

// Sidebar sections (sidebarSections.ts): shared by the workspace, changed with `sidebar.arrange`, folded
// by anyone; each item in one of its tab's sections at most, cut to what each person sees.

afterEach(() => vi.useRealTimers());

const layout = async (as: As) => (await as.query(api.arrangements.get))!;
const sectionsOf = async (as: As, tab: SectionTab) => (await layout(as)).sections.filter((s) => s.tab === tab).map(({ name, ids }) => ({ name, ids }));
const idsOf = async (as: As, list: "channels" | "databases" | "pages" | "sectionOrder" | "folded") => (await layout(as)).rows.find((r) => r.list === list && !r.entityId)?.ids;
const place = (as: As, tab: SectionTab, id: string, sectionId: Id<"sidebarSections"> | null, beforeId: string | null = null, fill?: string[]) =>
	as.mutation(api.sidebarSections.place, { tab, id, sectionId, beforeId, fill });

it("holds each channel in one section at a time, and gives it back to the channels list where it's dropped", async () => {
	const { owner } = await ownerAndMember();
	const general = (await generalOf(owner))._id;
	const [sales, ops] = await Promise.all(["sales", "ops"].map((name) => owner.mutation(api.chats.createChannel, { name, private: false })));
	const team = await owner.mutation(api.sidebarSections.create, { tab: "chat", name: "  Team  " });
	const later = await owner.mutation(api.sidebarSections.create, { tab: "chat", name: "Later" });
	await place(owner, "chat", sales!, team);
	await place(owner, "chat", ops!, team, sales!);
	expect(await sectionsOf(owner, "chat")).toEqual([{ name: "Team", ids: [ops, sales] }, { name: "Later", ids: [] }]);
	// Into another section: it leaves the first.
	await place(owner, "chat", sales!, later);
	expect(await sectionsOf(owner, "chat")).toEqual([{ name: "Team", ids: [ops] }, { name: "Later", ids: [sales] }]);
	// Back among the channels in none, before #general (shown but never saved: `fill`).
	await place(owner, "chat", ops!, null, general, []);
	await place(owner, "chat", sales!, null, null, [ops!, general]);
	expect(await sectionsOf(owner, "chat")).toEqual([{ name: "Team", ids: [] }, { name: "Later", ids: [] }]);
	expect(await idsOf(owner, "channels")).toEqual([ops, general, sales]);
	// Sections reorder like any shared list (unsaved ones follow, oldest first); only sections go in it.
	await owner.mutation(api.arrangements.change, { list: "sectionOrder", command: { op: "move", id: later, beforeId: team } });
	expect(await idsOf(owner, "sectionOrder")).toEqual([later]);
	await expect(owner.mutation(api.arrangements.change, { list: "sectionOrder", command: { op: "move", id: general, beforeId: null } })).rejects.toThrow("Not found.");
	await owner.mutation(api.sidebarSections.rename, { sectionId: later, name: "Soon" });
	await expect(owner.mutation(api.sidebarSections.rename, { sectionId: later, name: " " })).rejects.toThrow("Give the section a name.");
	// Deleting one gives back what it held, and takes it out of the order.
	await place(owner, "chat", sales!, later);
	await owner.mutation(api.sidebarSections.remove, { sectionId: later });
	expect(await sectionsOf(owner, "chat")).toEqual([{ name: "Team", ids: [] }]);
	expect(await idsOf(owner, "sectionOrder")).toEqual([]);
});

it("takes only its own tab's things, each tab its own sections", async () => {
	const { t, owner } = await ownerAndMember();
	const general = (await generalOf(owner))._id;
	const type = (await owner.query(api.recordTypes.list))[0]!;
	const other = await owner.mutation(api.recordTypes.create, { plural: "Projects" });
	const folder = await owner.mutation(api.pages.create, { title: "Contracts", kind: "folder" });
	const page = await owner.mutation(api.pages.create, { title: "Wiki" });
	const nested = await owner.mutation(api.pages.create, { title: "Inside", parentId: folder });
	const file = await owner.mutation(api.driveFiles.add, { file: await upload(owner) });
	const chat = await owner.mutation(api.sidebarSections.create, { tab: "chat", name: "Chat" });
	const dbs = await owner.mutation(api.sidebarSections.create, { tab: "databases", name: "Sales" });
	const drive = await owner.mutation(api.sidebarSections.create, { tab: "drive", name: "Team" });
	await expect(place(owner, "chat", type._id, chat)).rejects.toThrow("Not found.");
	await expect(place(owner, "databases", type._id, chat)).rejects.toThrow("Section not found.");
	await expect(place(owner, "drive", nested, drive)).rejects.toThrow("Not found.");
	await place(owner, "chat", general, chat);
	await place(owner, "databases", type._id, dbs);
	await place(owner, "databases", other, null, type._id, [type._id]);
	for (const id of [file, folder, page]) await place(owner, "drive", id, drive, null);
	expect(await sectionsOf(owner, "databases")).toEqual([{ name: "Sales", ids: [type._id] }]);
	expect(await idsOf(owner, "databases")).toEqual([other, type._id]);
	expect(await sectionsOf(owner, "drive")).toEqual([{ name: "Team", ids: [file, folder, page] }]);
	const rows = await owner.query(api.sidebarSections.driveRows, { sectionId: drive });
	expect(rows.pages.map((p) => [p._id, p.hasChildren])).toEqual([[folder, true], [page, false]]);
	expect(rows.files.map((f) => f._id)).toEqual([file]);
	// A file back in All files just leaves the section (files go by name); a page goes where it's dropped.
	await place(owner, "drive", file, null);
	await place(owner, "drive", page, null, folder, [folder]);
	expect(await sectionsOf(owner, "drive")).toEqual([{ name: "Team", ids: [folder] }]);
	expect(await idsOf(owner, "pages")).toEqual([page, folder]);
	// Moving into a folder takes it out: sections hold the top level only.
	await place(owner, "drive", page, drive);
	await owner.mutation(api.pages.move, { pageId: page, parentId: folder });
	await place(owner, "drive", file, drive);
	await owner.mutation(api.driveFiles.move, { fileId: file, parentId: folder });
	await owner.mutation(api.pages.move, { pageId: page });
	expect(await sectionsOf(owner, "drive")).toEqual([{ name: "Team", ids: [folder] }]);
	expect(await t.run(async (ctx) => (await ctx.db.get(drive))!.ids)).toEqual([folder]);
});

it("needs sidebar.arrange to change sections; anyone sees them and folds them", async () => {
	const { owner, member } = await ownerAndMember();
	const general = (await generalOf(owner))._id;
	const team = await owner.mutation(api.sidebarSections.create, { tab: "chat", name: "Team" });
	await setMemberSwitch(owner, "sidebar.arrange", false);
	const denied = "rearrange shared sidebar lists";
	await expect(member.mutation(api.sidebarSections.create, { tab: "chat", name: "Mine" })).rejects.toThrow(denied);
	await expect(member.mutation(api.sidebarSections.rename, { sectionId: team, name: "Ours" })).rejects.toThrow(denied);
	await expect(member.mutation(api.sidebarSections.remove, { sectionId: team })).rejects.toThrow(denied);
	await expect(place(member, "chat", general, team)).rejects.toThrow(denied);
	await expect(member.mutation(api.arrangements.change, { list: "sectionOrder", command: { op: "move", id: team, beforeId: null } })).rejects.toThrow(denied);
	expect(await sectionsOf(member, "chat")).toEqual([{ name: "Team", ids: [] }]);
	await member.mutation(api.arrangements.change, { list: "folded", command: { op: "add", id: team } });
	await expect(member.mutation(api.arrangements.change, { list: "folded", command: { op: "add", id: "nonsense" } })).rejects.toThrow("Not found.");
	expect(await idsOf(member, "folded")).toEqual([team]);
	expect(await idsOf(owner, "folded")).toBeUndefined();
});

it("shows each person only what they can see, and keeps the rest where it was", async () => {
	const { owner, member } = await ownerAndMember();
	const general = (await generalOf(owner))._id;
	const secret = await owner.mutation(api.chats.createChannel, { name: "secret", private: true });
	const team = await owner.mutation(api.sidebarSections.create, { tab: "chat", name: "Team" });
	await place(owner, "chat", secret, team);
	await place(owner, "chat", general, team);
	expect(await sectionsOf(member, "chat")).toEqual([{ name: "Team", ids: [general] }]);
	await expect(place(member, "chat", secret, null)).rejects.toThrow("Not found.");
	await expect(place(member, "chat", general, team, secret)).rejects.toThrow("Not found.");
	await place(member, "chat", general, team);
	expect(await sectionsOf(owner, "chat")).toEqual([{ name: "Team", ids: [secret, general] }]);
});

it("lets go of what's deleted forever, keeps what's archived, and goes with its workspace", async () => {
	const { t, owner } = await ownerAndMember();
	const channel = await owner.mutation(api.chats.createChannel, { name: "old", private: false });
	const type = await owner.mutation(api.recordTypes.create, { plural: "Projects" });
	const page = await owner.mutation(api.pages.create, { title: "Old" });
	const file = await owner.mutation(api.driveFiles.add, { file: await upload(owner) });
	const sections = { chat: await owner.mutation(api.sidebarSections.create, { tab: "chat", name: "A" }), databases: await owner.mutation(api.sidebarSections.create, { tab: "databases", name: "B" }), drive: await owner.mutation(api.sidebarSections.create, { tab: "drive", name: "C" }) };
	const items = [["chat", "channel", channel], ["databases", "database", type], ["drive", "page", page], ["drive", "file", file]] as const;
	for (const [tab, , id] of items) await place(owner, tab, id, sections[tab]);
	const stored = () => t.run(async (ctx) => (await ctx.db.query("sidebarSections").collect()).flatMap((s) => s.ids));
	const shown = async () => (await layout(owner)).sections.flatMap((s) => s.ids);
	vi.useFakeTimers();
	for (const [, kind, id] of items) await owner.mutation(api.trash.move, { kind, id });
	// Archived: out of sight, still held, back on restore.
	expect(await shown()).toEqual([]);
	expect(await stored()).toEqual([channel, type, page, file]);
	await owner.mutation(api.trash.restore, { kind: "page", id: page });
	expect(await shown()).toEqual([page]);
	await owner.mutation(api.trash.move, { kind: "page", id: page });
	for (const [, , id] of items) await owner.mutation(api.trash.purge, { id });
	await settle(t);
	expect(await stored()).toEqual([]);
	await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
	await settle(t);
	expect(await t.run((ctx) => ctx.db.query("sidebarSections").collect())).toEqual([]);
});

it("moves Inbox's views within and between sections like any tab's, and keeps its Channels group to itself", async () => {
	const { owner, member } = await ownerAndMember();
	// It starts with no sections: Channels and Tags are built in, like Direct messages.
	expect(await sectionsOf(owner, "inbox")).toEqual([]);
	const mine = await owner.mutation(api.sidebarSections.create, { tab: "inbox", name: "Mine" });
	// A view in no section moves in; one in a section moves out, back among the views in none where it's dropped.
	await place(owner, "inbox", "needs", mine);
	await place(owner, "inbox", "agent", mine, "needs");
	await place(owner, "inbox", "agent", null, "all", ["mine", "all"]);
	expect(await sectionsOf(owner, "inbox")).toEqual([{ name: "Mine", ids: ["needs"] }]);
	expect((await layout(owner)).rows.find((r) => r.list === "inbox")?.ids).toEqual(["mine", "agent", "all"]);
	// Channels reorder within their group, and never go into a section.
	await owner.mutation(api.arrangements.change, { list: "inboxChannels", command: { op: "move", id: "sms", beforeId: "email", fill: ["email", "sms"] } });
	expect((await layout(owner)).rows.find((r) => r.list === "inboxChannels")?.ids).toEqual(["sms", "email"]);
	await expect(place(owner, "inbox", "email", mine)).rejects.toThrow("Not found.");
	await expect(owner.mutation(api.arrangements.change, { list: "inbox", command: { op: "move", id: "email", beforeId: null } })).rejects.toThrow();
	// Only with `sidebar.arrange`.
	await setMemberSwitch(owner, "sidebar.arrange", false);
	await expect(place(member, "inbox", "mine", mine)).rejects.toThrow();
});

it("holds Inbox conversations in its sections, for people who can use Inbox, and lets them out without listing them", async () => {
	const { t, owner, member } = await ownerAndMember();
	const workspaceId = await workspaceOf(owner);
	const conversation = (): Promise<string> => t.run((ctx) => ctx.db.insert("inboxConversations", { workspaceId, channel: "email", via: "hello@co.test", contact: "dana@acme.com", mode: "staff", lastAt: Date.now(), preview: "Hi" }));
	const [dana, lee] = [await conversation(), await conversation()];
	const priority = await owner.mutation(api.sidebarSections.create, { tab: "inbox", name: "Priority" });
	await place(owner, "inbox", dana, priority);
	await place(owner, "inbox", lee, priority, dana);
	expect(await sectionsOf(owner, "inbox")).toEqual([{ name: "Priority", ids: [lee, dana] }]);
	// Out of its section, it just leaves: Inbox's rows in no section are only its views.
	await place(owner, "inbox", lee, null, null, ["needs", "mine", "agent", "all"]);
	expect(await sectionsOf(owner, "inbox")).toEqual([{ name: "Priority", ids: [dana] }]);
	expect((await layout(owner)).rows.find((r) => r.list === "inbox")?.ids ?? []).not.toContain(lee);
	// Someone who can't use Inbox doesn't see it there, and can't move it.
	await setMemberSwitch(owner, "inbox.use", false);
	expect(await sectionsOf(member, "inbox")).toEqual([{ name: "Priority", ids: [] }]);
	await expect(place(member, "inbox", lee, priority)).rejects.toThrow();
});
