import { z } from "zod";
import { monthLabel, formatUsd } from "./usage";
import { type ToolDef, defineTool, resultText } from "./tools";

/** What a workspace may spend on pictures a month, in USD, until an owner sets it. 0 turns pictures off. */
export const IMAGE_BUDGET_DEFAULT_USD = 20;
/** The most an owner can set: a typo shouldn't open the tap. */
export const IMAGE_BUDGET_MAX_USD = 10_000;
/** Pictures one call can edit from. */
export const EDIT_FILES_MAX = 4;

export const aspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export type AspectRatio = (typeof aspectRatios)[number];

export interface ImageRequest {
	prompt: string;
	aspectRatio?: AspectRatio;
	/** File ids from the chat ("<message id>/<n>") to edit or draw from. */
	editFiles?: string[];
}

/** Making pictures, from the backend: it checks the budget and edit files, generates, attaches and records the cost. */
export interface ImageStore {
	generate(request: ImageRequest): Promise<{ attached: { id: string; name: string }[]; model: string; note?: string } | { error: string }>;
}

/** Why a workspace can't make a picture now, or null. `month` is "2026-10". */
export function imageBudgetError(budgetUsd: number, spentUsd: number, month: string) {
	const where = "an owner can change it in Settings → General ([General](#/settings/general))";
	if (budgetUsd <= 0) return `Pictures are turned off in this workspace (its monthly image budget is $0); ${where}.`;
	if (spentUsd >= budgetUsd) return `This workspace's image budget for ${monthLabel(month)} (${formatUsd(budgetUsd)}) is used up; ${where}.`;
	return null;
}

export const imageTools: ToolDef[] = [
	defineTool({
		id: "images.generate",
		title: "Make a picture",
		description:
			"Make a picture from a prompt, or edit pictures from the chat (editFiles: their file ids). It's attached to your reply. Costs money from the workspace's monthly image budget, so make one only when asked, and don't remake it unasked.",
		input: z.object({
			prompt: z.string().min(1).describe("What to draw, or what to change in editFiles: subject, style, text to show, composition"),
			aspectRatio: z.enum(aspectRatios).optional().describe("Width:height; square if left out"),
			editFiles: z.array(z.string()).max(EDIT_FILES_MAX).optional().describe('Picture file ids from the chat ("<message id>/<n>") to edit or use as references'),
		}),
		// Nothing leaves the workspace, but it spends money and can read pictures from the person's
		// private chats: a run following someone else's words asks first, like other `inside` tools.
		risk: "inside",
		label: (input, output) => {
			const done = output && typeof output === "object" && "attached" in output;
			return input.editFiles?.length ? (done ? "Edited a picture" : "Edit a picture") : done ? "Made a picture" : "Make a picture";
		},
		execute: (input, { images }) => images.generate(input),
		// A receipt, never the picture: the person sees it on the reply.
		toModelOutput: ({ output }) => ({
			type: "text",
			value:
				resultText(output, "error") ??
				`Attached to your reply: ${((output as { attached: { id: string; name: string }[] }).attached ?? []).map((a) => `${a.name} (${a.id})`).join(", ")}. Don't describe it at length or repeat it.${resultText(output, "note") ? ` ${resultText(output, "note")}` : ""}`,
		}),
	}),
];
