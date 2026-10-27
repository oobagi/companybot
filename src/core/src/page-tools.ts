import { z } from "zod";
import { type ToolDef, defineTool } from "./tools";

/**
 * Agents use pages as the person they're helping: wiki pages, SOPs, meeting notes, and the
 * page body every record has. Three tools: find, read as Markdown, write from Markdown (create,
 * replace, append, rename, archive, restore a version). The backend runs every call through the
 * same rules as the app (pageOps) and logs each write as a version "by <agent> for <person>".
 */
export interface PageStore {
	find(input: PageFindInput): Promise<unknown>;
	/** The whole page; the tool hands the model a part at a time. */
	read(input: { page?: string; record?: string }): Promise<PageRead | { error: string }>;
	write(input: PageWriteInput): Promise<unknown>;
}

export interface PageRead {
	/** None for a record's body nobody has written in yet. */
	id?: string;
	title: string;
	record?: string;
	markdown: string;
	/** Latest versions, newest first, with ids `restore` takes. */
	versions: { version: string; time: string; by: string; agent?: string }[];
}

/** Markdown the model reads per call; longer pages come in parts. */
export const PAGE_READ_MAX = 20_000;
const MARKDOWN_MAX = 200_000;

const target = {
	page: z.string().optional().describe("A page's id or exact title"),
	record: z.string().optional().describe("A record's id, for its page body (every record has one)"),
};

const findInput = z.object({
	search: z.string().optional().describe("Words in the title. Leave out to list pages by title."),
	cursor: z.string().optional().describe("From a previous result with more: true"),
});
export type PageFindInput = z.infer<typeof findInput>;

const writeInput = z.object({
	...target,
	title: z.string().optional().describe("A new page's title, or a new title for a page (not a record's body)"),
	markdown: z.string().max(MARKDOWN_MAX).optional().describe("Content in Markdown: headings, lists, - [ ] to-dos, > quotes, ``` code, --- dividers, tables"),
	mode: z.enum(["replace", "append"]).optional().describe("replace: the page becomes `markdown`; append (default): `markdown` goes at the end"),
	archived: z.boolean().optional().describe("true archives a page, false restores it. On its own."),
	restore: z.string().optional().describe("A version id from pages_read: its content comes back as a new version. On its own."),
});
export type PageWriteInput = z.infer<typeof writeInput>;

const text = (from: unknown, key: string) => {
	const v = from && typeof from === "object" ? (from as Record<string, unknown>)[key] : undefined;
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** "Create page Onboarding", "Write page Onboarding", "Archive page Onboarding". */
function writeLabel(input: PageWriteInput, output: unknown) {
	const title = text(output, "title");
	if (text(output, "error") || !title) return;
	if (input.restore) return `Restore a version of ${title}`;
	if (input.archived !== undefined) return `${input.archived ? "Archive" : "Restore"} page ${title}`;
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
		description: `A page, or a record's page body, as Markdown, ${PAGE_READ_MAX.toLocaleString("en-US")} characters at a time (more: true and next when there's more: call again with start), plus its latest versions with ids \`restore\` takes.`,
		input: z.object({ ...target, start: z.number().int().min(0).optional().describe("Where to read from, from a previous result's next") }),
		readOnly: true,
		async execute({ start = 0, ...input }, { pages }) {
			const page = await pages.read(input);
			if ("error" in page) return page;
			const end = start + PAGE_READ_MAX;
			const more = page.markdown.length > end;
			return { ...page, markdown: page.markdown.slice(start, end), ...(more && { more, next: end }) };
		},
		label: (_input, output) => (text(output, "title") ? `Read page ${text(output, "title")}` : undefined),
	}),
	defineTool({
		id: "pages.write",
		title: "Write a page",
		description:
			"Create a page (title, optional markdown), add to a page or a record's page body (append), rewrite it (replace), rename it, archive or restore it, or bring back an old version. Runs right away and is saved in the page's history as you acting for the person, so it can be restored. Read a page before replacing it.",
		input: writeInput,
		execute: (input, { pages }) => pages.write(input),
		label: writeLabel,
	}),
];
