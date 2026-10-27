import { z } from "zod";
import { type ToolDef, defineTool, resultText as text } from "./tools";

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
	title: string;
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

export const readInput = z.object({
	...target,
	version: z.string().optional().describe("Preview this historical version id instead of current content"),
	history: z.boolean().optional().describe("List 20 versions per call instead of content; continue with cursor"),
	cursor: z.string().optional().describe("Next history page"),
	format: z.enum(["markdown", "blocks"]).optional().describe("blocks returns a JSON array of ProseMirror blockContainer nodes, preserving every editor property; use it for formatted edits"),
	start: z.number().int().min(0).optional().describe("Content offset from next; concatenate every chunk before editing JSON"),
});
export type PageReadInput = z.infer<typeof readInput>;

const findInput = z.object({
	search: z.string().optional().describe("Words in the title. Leave out to list pages by title."),
	trashed: z.boolean().optional().describe("Pages in Trash instead"),
	cursor: z.string().optional().describe("From a previous result with more: true"),
});
export type PageFindInput = z.infer<typeof findInput>;

export const writeInput = z.object({
	...target,
	title: z.string().optional().describe("A new page's title, or a new title for a page (not a record's body)"),
	markdown: z.string().max(MARKDOWN_MAX).optional().describe("Content in Markdown: headings, lists, - [ ] to-dos, > quotes, ``` code, --- dividers, tables"),
	blocks: z.string().max(500_000).optional().describe("JSON array from pages_read format blocks, edited with properties intact. Use instead of markdown; append or replace."),
	mode: z.enum(["replace", "append"]).optional().describe("replace: the page becomes `markdown`; append (default): `markdown` goes at the end"),
	trash: z.boolean().optional().describe("true deletes a page (to Trash, restorable for 30 days); false restores it. On its own."),
	restore: z.string().optional().describe("A version id from pages_read: its content comes back as a new version. On its own."),
});
export type PageWriteInput = z.infer<typeof writeInput>;

/** "Create page Onboarding", "Write page Onboarding", "Delete page Onboarding". */
function writeLabel(input: PageWriteInput, output: unknown) {
	const title = text(output, "title");
	if (text(output, "error") || !title) return;
	if (input.restore) return `Restore a version of ${title}`;
	if (input.trash !== undefined) return `${input.trash ? "Delete" : "Restore"} page ${title}`;
	if (!input.page && !input.record) return `Create page ${title}`;
	return input.markdown === undefined ? `Update page ${title}` : `Write page ${title}`;
}

export const pageTools: ToolDef[] = [
	defineTool({
		id: "pages.find",
		title: "Find pages",
		description: "The workspace's pages (wiki, how-tos, meeting notes): by title, or matching words in the title. Records' page bodies aren't listed: find the record, then read it with `record`.",
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
		description: `List full history (history with cursor), preview an old version (version), or read a page, or a record's page body, as Markdown, ${PAGE_READ_MAX.toLocaleString("en-US")} characters at a time (more: true and next when there's more: call again with start), plus its latest versions with ids \`restore\` takes.`,
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
			"Create a page (title, optional markdown), add to a page or a record's page body (append), rewrite it (replace), rename it, delete it (to Trash) or restore it, or bring back an old version. Runs right away and is saved in the page's history as you acting for the person, so it can be restored. Read a page before replacing it.",
		input: writeInput,
		execute: (input, { pages }) => pages.write(input),
		label: writeLabel,
	}),
];
