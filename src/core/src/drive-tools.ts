import { z } from "zod";
import type { FileResult } from "./chat";
import { type ToolDef, defineTool, resultText as text } from "./tools";

// Files in Drive (wiki/drive.md), for agents: find them, read their text, and save, rename, move or
// archive them. Folders are pages (page-tools.ts: pages_find lists them with kind "folder";
// pages_write makes one with kind "folder"). Backend driveTools.ts applies the acting person's permissions.

/** Files in Drive as the person the agent acts for sees them. Implementations check access on every call. */
export interface FileStore {
	find(input: FileFindInput): Promise<unknown>;
	read(input: FileReadInput): Promise<FileResult>;
	write(input: FileWriteInput): Promise<unknown>;
}

export const fileFindInput = z.object({
	folder: z.string().nullable().optional().describe("List the files in this folder (id or exact name); null lists the top level of Drive. Folders themselves are pages_find rows with kind folder."),
	search: z.string().optional().describe("Words in the file name. Leave out to list files by name."),
	trashed: z.boolean().optional().describe("Files in Archive instead"),
	cursor: z.string().optional().describe("From a previous result with more: true"),
});
export type FileFindInput = z.infer<typeof fileFindInput>;

export const fileReadInput = z.object({
	file: z.string().describe("A file's id or exact name"),
	page: z.number().int().min(1).optional().describe("Default 1"),
});
export type FileReadInput = z.infer<typeof fileReadInput>;

/** Longest text file an agent writes. */
export const FILE_TEXT_MAX = 500_000;

export const fileWriteInput = z.object({
	file: z.string().optional().describe("The file to change, by its id (files_find gives it): never its name, which can change"),
	name: z.string().optional().describe("A new file's name, with its extension (notes.md, leads.csv), or a new name for a file"),
	folder: z.string().nullable().optional().describe("Where a new file goes, or where to move one: a folder's id (pages_find gives it), not its title; null is the top level of Drive"),
	from: z.string().optional().describe('Save a copy of a file from the chat, by its file id ("<message id>/<n>"): a document someone attached, or one you made'),
	text: z.string().max(FILE_TEXT_MAX).optional().describe("Make a text file with this content: .txt, .md, .csv or .json by name"),
	trash: z.boolean().optional().describe("true archives a file (to Archive, kept until restored or explicitly deleted forever); false restores it. On its own."),
});
export type FileWriteInput = z.infer<typeof fileWriteInput>;

/** "Save file Q3.pdf", "Rename file Q3.pdf", "Move file Q3.pdf", "Archive file Q3.pdf". */
function writeLabel(input: FileWriteInput, output: unknown) {
	const name = text(output, "name");
	if (text(output, "error") || !name) return;
	if (input.trash !== undefined) return `${input.trash ? "Archive" : "Restore"} file ${name}`;
	if (!input.file) return `Save file ${name}`;
	if (input.folder !== undefined) return `Move file ${name}`;
	return `Rename file ${name}`;
}

export const driveTools: ToolDef[] = [
	defineTool({
		id: "files.find",
		title: "Find files",
		description: "The files in Drive (PDFs, Word, Excel and PowerPoint files, pictures, text): by name, matching words in the name, or in one folder. Rows include folderId. Folders are pages: list them with pages_find.",
		input: fileFindInput,
		readOnly: true,
		execute: (input, { files }) => files.find(input),
		label: (_input, output) => {
			const rows = (output as { rows?: unknown[] } | undefined)?.rows;
			return Array.isArray(rows) ? `Find ${rows.length || "no"} file${rows.length === 1 ? "" : "s"}` : undefined;
		},
	}),
	defineTool({
		id: "files.read",
		title: "Read a file",
		description: "Read the text of a file in Drive (PDF, Word, Excel as CSV per sheet, PowerPoint as slides, CSV, text), by id or exact name. Long files come in pages: ask for the next with page.",
		input: fileReadInput,
		readOnly: true,
		label: (_input, output) => {
			const name = text(output, "name");
			return name && `Read ${JSON.stringify(name)}`;
		},
		execute: (input, { files }) => files.read(input),
	}),
	defineTool({
		id: "files.write",
		title: "Save a file",
		description:
			"Put a file in Drive: a copy of one from the chat (from, by file id) or a new text file (text and name), in a folder or at the top level. Or rename a file (file and name), move it (file and folder; null for the top level), archive it (trash true) or restore it. Name files by id (files_find gives them). Archiving waits for confirmation; other changes run right away in the person's own chats, as you acting for the person.",
		input: fileWriteInput,
		risk: "inside",
		riskFor: (input) => (input.trash === true ? "locked" : "inside"),
		execute: (input, { files }) => files.write(input),
		label: writeLabel,
	}),
];
