import {
	type AspectRatio,
	type ImageStore,
	EDIT_FILES_MAX,
	IMAGE_BUDGET_DEFAULT_USD,
	IMAGE_PRICE_UNKNOWN_USD,
	aspectRatios,
	gatewayCost,
	imageBudgetError,
	imageSize,
	isImageType,
	modelTakesImage,
	sniffImage,
	usageMonth,
} from "@companybot/core";
import { generateImage, generateText } from "ai";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type QueryCtx, internalAction, internalMutation } from "./_generated/server";
import { visibleFile } from "./files";
import { workspaceImageModel } from "./modelCatalog";
import { addTurnCost, runningTurn } from "./turns";
import { imageSpent, recordUsage } from "./usage";

// Pictures agents make (images.generate), through AI Gateway with the workspace's picture model
// (Settings → General). Image models run with generateImage, multimodal language models (Nano Banana)
// with generateText, answering with files. Each picture is stored with the type its bytes say and
// attached to the turn's reply (files.attachToReply); what it cost goes to `usage` as kind "image",
// for the turn's person and agent, which is what the monthly image budget is checked against. While a
// call runs, its estimated cost is held (`imageHolds`) so parallel calls see it.

/** A hold this old is released even if its call never settled (the action crashed): longer than an action runs. */
const HOLD_MS = 15 * 60_000;

type Model = { id: string; multimodal: boolean; perImage?: number };
type Picture = { data: Uint8Array; type: string };
type Ready = { model: Model; files: { storageId: Id<"_storage">; type: string }[]; holdId: Id<"imageHolds"> };

/** What a picture costs when the gateway doesn't say: its listed price, else a conservative guess. */
const pictureCost = (model: Model) => model.perImage ?? IMAGE_PRICE_UNKNOWN_USD;

/** What calls still running have held against the budget. */
async function heldUsd(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
	const holds = await ctx.db.query("imageHolds").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(500);
	return holds.reduce((sum, h) => sum + h.costUsd, 0);
}

/**
 * What a generation needs, checked as the turn's person now: the budget (this month's spend plus what
 * running calls hold), the model, and the edit files they can see. Holds one picture's cost until it settles.
 */
export const prepareFor = internalMutation({
	args: { turnId: v.id("agentTurns"), editFiles: v.array(v.string()) },
	handler: async (ctx, { turnId, editFiles }): Promise<Ready | { error: string }> => {
		const { member } = await runningTurn(ctx, turnId);
		const workspace = (await ctx.db.get(member.workspaceId))!;
		const month = usageMonth(Date.now());
		const budget = workspace.imageBudgetUsd ?? IMAGE_BUDGET_DEFAULT_USD;
		const spent = budget > 0 ? (await imageSpent(ctx, member.workspaceId, month)) + (await heldUsd(ctx, member.workspaceId)) : 0;
		const refused = imageBudgetError(budget, spent, month);
		if (refused) return { error: refused };
		const files: Ready["files"] = [];
		for (const id of editFiles) {
			const file = await visibleFile(ctx, member, id);
			if (!file) return { error: `No file "${id}" in a chat you can see.` };
			if (!isImageType(file.type)) return { error: `${file.name} isn't a picture, so it can't be edited.` };
			if (!modelTakesImage(file)) return { error: `${file.name} is too big to edit (pictures up to 5 MB and 8000px).` };
			files.push({ storageId: file.storageId, type: file.type });
		}
		const found = await workspaceImageModel(ctx, workspace.imageModel);
		const model: Model = { id: found.id, multimodal: !!found.multimodal, ...(found.perImage !== undefined && { perImage: found.perImage }) };
		const holdId = await ctx.db.insert("imageHolds", { workspaceId: member.workspaceId, costUsd: pictureCost(model) });
		await ctx.scheduler.runAfter(HOLD_MS, internal.imageGen.release, { holdId });
		return { model, files, holdId };
	},
});

/** A call finished: its hold becomes what it really cost, for the turn's person and agent, and on the turn's place and reply. */
export const settle = internalMutation({
	args: { holdId: v.id("imageHolds"), turnId: v.id("agentTurns"), model: v.string(), costUsd: v.number() },
	handler: async (ctx, { holdId, turnId, model, costUsd }) => {
		if (await ctx.db.get(holdId)) await ctx.db.delete(holdId);
		const turn = await ctx.db.get(turnId);
		if (!turn) return;
		const counted = await recordUsage(ctx, { workspaceId: turn.workspaceId, userId: turn.actorId, agentId: turn.agentId, kind: "image", model, costUsd });
		if (counted) await addTurnCost(ctx, turn, "imageCostUsd", costUsd);
	},
});

/** A call failed, or never settled: its hold goes. */
export const release = internalMutation({
	args: { holdId: v.id("imageHolds") },
	handler: async (ctx, { holdId }) => {
		if (await ctx.db.get(holdId)) await ctx.db.delete(holdId);
	},
});

/** Calls the model. Cost is what the gateway billed, else the listed price (or IMAGE_PRICE_UNKNOWN_USD) per picture. */
export async function makePictures(model: Model, prompt: string, aspectRatio: AspectRatio | undefined, edits: Picture[]) {
	let made: Uint8Array[];
	let costUsd: number;
	if (model.multimodal) {
		const result = await generateText({
			model: model.id,
			messages: [{ role: "user", content: [...edits.map((p) => ({ type: "file" as const, mediaType: p.type, data: p.data })), { type: "text", text: prompt }] }],
			...(aspectRatio && { providerOptions: { google: { imageConfig: { aspectRatio } } } }),
		});
		made = result.files.filter((f) => f.mediaType.startsWith("image/")).map((f) => f.uint8Array);
		costUsd = gatewayCost(result.providerMetadata);
	} else {
		const result = await generateImage({
			model: model.id,
			prompt: edits.length ? { images: edits.map((p) => p.data), text: prompt } : prompt,
			...(aspectRatio && { aspectRatio }),
		});
		made = result.images.map((i) => i.uint8Array);
		costUsd = result.calls.reduce((sum, c) => sum + gatewayCost(c.providerMetadata as never), 0);
	}
	return { made, costUsd: costUsd > 0 ? costUsd : pictureCost(model) * made.length };
}

/** images.generate for a running turn: a short receipt, or `{ error }` for the agent to relay. */
export const generateFor = internalAction({
	args: {
		turnId: v.id("agentTurns"),
		prompt: v.string(),
		aspectRatio: v.optional(v.union(...aspectRatios.map((r) => v.literal(r)))),
		editFiles: v.optional(v.array(v.string())),
	},
	handler: async (ctx, { turnId, prompt, aspectRatio, editFiles = [] }): ReturnType<ImageStore["generate"]> => {
		if (editFiles.length > EDIT_FILES_MAX) return { error: `Edit up to ${EDIT_FILES_MAX} pictures at once.` };
		const ready = await ctx.runMutation(internal.imageGen.prepareFor, { turnId, editFiles });
		if ("error" in ready) return { error: ready.error };
		const { model, files, holdId } = ready;
		let made: Uint8Array[] = [];
		let settled = false;
		try {
			const edits: Picture[] = [];
			for (const f of files) {
				const blob = await ctx.storage.get(f.storageId);
				if (!blob) return { error: "A picture to edit was deleted." };
				edits.push({ data: new Uint8Array(await blob.arrayBuffer()), type: f.type });
			}
			const result = await makePictures(model, prompt, aspectRatio, edits);
			made = result.made;
			// Paid for whether or not it can be attached.
			await ctx.runMutation(internal.imageGen.settle, { holdId, turnId, model: model.id, costUsd: result.costUsd });
			settled = true;
		} finally {
			// A failed call frees its hold now; a crash frees it after HOLD_MS.
			if (!settled) await ctx.runMutation(internal.imageGen.release, { holdId });
		}
		const attached: { id: string; name: string }[] = [];
		let refused: string | undefined;
		for (const data of made) {
			// The type comes from the bytes, never the provider's label; anything else (SVG) isn't kept.
			const type = sniffImage(data);
			if (!type) continue;
			const name = `picture${attached.length ? `-${attached.length + 1}` : ""}.${type.slice("image/".length).replace("jpeg", "jpg")}`;
			const storageId = await ctx.storage.store(new Blob([data as Uint8Array<ArrayBuffer>], { type }));
			const result = await ctx.runMutation(internal.files.attachToReply, { turnId, storageId, name, ...imageSize(data, type) });
			if ("error" in result) {
				refused = result.error;
				break;
			}
			attached.push({ id: result.id, name });
		}
		if (attached.length === 0) return { error: refused ?? `${model.id} made no picture this time. Try again, or reword the prompt.` };
		return { attached, model: model.id, ...(refused && { note: `Not all were attached: ${refused}` }) };
	},
});
