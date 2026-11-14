import { z } from "zod";
import { type Bound, type ToolDef, defineTool, resultText as text } from "./tools";

/** Pages and record bodies as Markdown; backend pageOps applies the acting person's permissions. */
export interface PageStore {
	find(input: PageFindInput): Promise<unknown>;
	/** The whole page; the tool hands the model a part at a time. */
	read(input: PageReadInput): Promise<PageRead | { error: string }>;
	write(input: PageWriteInput): Promise<unknown>;
}

export interface PageRead {
	/** None for a record's body nobody has written in yet. */
	id?: string;
	/** A folder (no content; its contents are `subpages` and `files`), or a page. */
	kind?: "page" | "folder";
	title: string;
	parentId?: string | null;
	ancestors?: { id: string; title: string; record?: string }[];
	subpages?: { id: string; kind?: "page" | "folder"; title: string }[];
	subpagesMore?: boolean;
	/** A folder's files. */
	files?: { id: string; name: string; type: string }[];
	filesMore?: boolean;
	record?: string;
	markdown: string;
	blocks?: string;
	cursor?: string;
	moreVersions?: boolean;
	/** Latest versions, newest first, with ids `restore` takes. */
	versions: { version: string; time: string; by: string; agent?: string; others?: string[] }[];
}

/** Markdown the model reads per call; longer pages come in parts. */
export const PAGE_READ_MAX = 20_000;
const MARKDOWN_MAX = 200_000;

const target = {
	page: z.string().optional().describe("A page's id or exact title"),
	record: z.string().optional().describe("A record's id, for its page body (every record has one)"),
};
/**
 * Writes name what they change by id only: a held call runs on the page it was approved for, even if
 * that page is renamed and another takes its old title meanwhile. Titles are looked up by pages_find and pages_read.
 */
const writeTarget = {
	page: z.string().optional().describe("The page's id, from pages_find or pages_read (not its title)"),
	record: target.record,
};

export const readInput = z.object({
	...target,
	version: z.string().optional().describe("Preview this historical version id instead of current content"),
	history: z.boolean().optional().describe("List 20 versions per call instead of content; continue with cursor"),
	cursor: z.string().optional().describe("Next history page"),
	format: z.enum(["markdown", "blocks"]).optional().describe("blocks returns a JSON array of ProseMirror blockContainer nodes, preserving every editor property; use it for formatted edits"),
	start: z.number().int().min(0).optional().describe("Content offset from next; concatenate every chunk before editing JSON"),
});
export type PageReadInput = z.infer<typeof readInput>;

export const findInput = z.object({
	parent: z.string().nullable().optional().describe("List what's directly in this page or folder (id or exact title), or in a record's page by the record's id; null lists the top level of Drive. Rows include parentId and kind (page or folder), so page through every level to read the tree."),
	search: z.string().optional().describe("Words in the title. Leave out to list pages by title."),
	trashed: z.boolean().optional().describe("Pages and folders in Archive instead"),
	cursor: z.string().optional().describe("From a previous result with more: true"),
});
export type PageFindInput = z.infer<typeof findInput>;

export const writeInput = z.object({
	action: z.union([z.literal("write"), z.literal("move")]).optional().describe("write (default) creates or edits a page or folder; move changes its parent and keeps content and descendants"),
	parent: z.string().nullable().optional().describe("Parent page or folder id (not its title), or a record's id to put the page in that record's page, for creation or action move; null moves to the top level of Drive. Folders go in folders only; a record's own page can't move."),
	...writeTarget,
	kind: z.literal("folder").optional().describe("Create a folder (title, optional parent) instead of a page: it holds pages, files and folders, and has no content"),
	title: z.string().optional().describe("A new page's or folder's title, or a new title for a page or folder (not a record's body)"),
	markdown: z.string().max(MARKDOWN_MAX).optional().describe("Content in Markdown: headings, lists, - [ ] to-dos, > quotes, ``` code, --- dividers, tables, and pictures from the chat as ![caption](<file id>), copied into the page"),
	blocks: z.string().max(500_000).optional().describe("JSON array from pages_read format blocks, edited with properties intact. Use instead of markdown; append or replace."),
	mode: z.enum(["replace", "append"]).optional().describe("replace: the page becomes `markdown`; append (default): `markdown` goes at the end"),
	trash: z.boolean().optional().describe("true archives a page (to Archive, kept until restored or explicitly deleted forever); false restores it. On its own."),
	restore: z.string().optional().describe("A version id from pages_read: its content comes back as a new version. On its own."),
});
export type PageWriteInput = z.infer<typeof writeInput>;

/**
 * What a write's effect depends on as it is now: archiving or restoring a page, bringing back a version
 * over it, or replacing its content. Appends, renames, moves and new pages don't.
 */
function pageBinds(input: PageWriteInput): Bound[] {
	const overwrites = input.trash !== undefined || input.restore !== undefined || (input.mode === "replace" && (input.markdown !== undefined || input.blocks !== undefined));
	if (!overwrites) return [];
	if (input.page) return [{ kind: "page", id: input.page }];
	if (input.record) return [{ kind: "recordPage", id: input.record }];
	return input.restore ? [{ kind: "pageVersion", id: input.restore }] : [];
}

/** "Create page Onboarding", "Write page Onboarding", "Delete page Onboarding". */
function writeLabel(input: PageWriteInput, output: unknown) {
	const title = text(output, "title");
	if (text(output, "error") || !title) return;
	if (input.restore) return `Restore a version of ${title}`;
	return `${writeAction(input, text(output, "kind") === "folder" ? "folder" : "page")} ${title}`;
}

/** "Archive page": what a write does, before anything names its page. A folder is known from `kind` on creation, else from the result. */
function writeAction(input: PageWriteInput, kind: "page" | "folder" = input.kind ?? "page") {
	if (input.action === "move") return `Move ${kind}`;
	if (input.restore) return "Restore a page version";
	if (input.trash !== undefined) return input.trash ? `Archive ${kind}` : `Restore ${kind}`;
	if (!input.page && !input.record) return `Create ${kind}`;
	return input.markdown === undefined ? `Update ${kind}` : `Write ${kind}`;
}

export const pageTools: ToolDef[] = [
	defineTool({
		id: "pages.find",
		title: "Find pages",
		description: "The workspace's pages (wiki, how-tos, meeting notes) and Drive's folders (kind folder): by title, or matching words in the title. Records' page bodies aren't listed: find the record, then read it with `record`, or list the pages inside it with `parent` set to the record's id. Files are files_find.",
		input: findInput,
		readOnly: true,
		execute: (input, { pages }) => pages.find(input),
		label: (_input, output) => {
			const rows = (output as { rows?: unknown[] } | undefined)?.rows;
			return Array.isArray(rows) ? `Find ${rows.length || "no"} page${rows.length === 1 ? "" : "s"}` : undefined;
		},
	}),
	defineTool({
		id: "pages.read",
		title: "Read a page",
		description: `List full history (history with cursor), preview an old version (version), or read a page, or a record's page body, as Markdown, ${PAGE_READ_MAX.toLocaleString("en-US")} characters at a time (more: true and next when there's more: call again with start), plus its latest versions with ids \`restore\` takes. A folder reads as what's in it: subpages (pages and folders) and files.`,
		input: readInput,
		readOnly: true,
		async execute({ start = 0, ...input }, { pages }) {
			const page = await pages.read(input);
			if ("error" in page) return page;
			const end = start + PAGE_READ_MAX;
			const content = page.blocks ?? page.markdown;
			const more = content.length > end;
			return { ...page, ...(page.blocks !== undefined ? { blocks: content.slice(start, end) } : { markdown: content.slice(start, end) }), ...(more && { more, next: end }) };
		},
		label: (_input, output) => (text(output, "title") ? `Read page ${text(output, "title")}` : undefined),
	}),
	defineTool({
		id: "pages.write",
		title: "Write a page",
		description:
			"Create a page (title, optional parent and markdown; parent can be a record's id, to put it in that record's page) or a folder (kind folder), move it (action move, page, parent; null for top level), add to a page or a record's page body (append), rewrite it (replace), rename it, delete it (to Archive) or restore it, or bring back an old version. Name pages by id (pages_find gives them). Archiving waits for confirmation. Other writes run right away in the person's own chats and are saved in the page's history as you acting for the person, so it can be restored. Read a page before replacing it.",
		input: writeInput,
		// Acting as the person, like records.save: runs in their own chats, asks in runs following someone
		// else's words, and Never rules and owner locks reach it. Archiving always asks.
		risk: "inside",
		riskFor: (input) => (input.trash === true ? "locked" : "inside"),
		binds: pageBinds,
		execute: (input, { pages }) => pages.write(input),
		label: writeLabel,
		action: writeAction,
		actionKeys: ["action", "trash"],
	}),
];
