import { IMAGE_PRICE_UNKNOWN_USD, defaultImageModel, usageMonth } from "@companybot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pngOf } from "../../core/test/files";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { type As, agentTurn, agentsOf, generalOf, noMentions, ownerAndMember, workspaceOf } from "./helpers";

// No network: the AI SDK's generateImage and generateText are stubbed, so nothing is billed.
const generateImage = vi.hoisted(() => vi.fn());
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateImage, generateText }));

type T = Awaited<ReturnType<typeof ownerAndMember>>["t"];
const picture = pngOf(8, 6);

beforeEach(() => {
	generateText.mockReset().mockResolvedValue({ files: [{ mediaType: "image/png", uint8Array: picture }], providerMetadata: { gateway: { cost: "0.04" } } });
	generateImage.mockReset().mockResolvedValue({ images: [{ mediaType: "image/png", uint8Array: picture }], calls: [{ providerMetadata: {} }] });
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** A running Companybot turn for `as` in #general. */
async function turnOf(t: T, as: As) {
	const { companybot } = await agentsOf(as);
	const turnId = await agentTurn(t, as, (await generalOf(as))._id, companybot._id);
	const replyId = (await t.run((ctx) => ctx.db.get("agentTurns", turnId)))!.replyId!;
	return { turnId, replyId, agentId: companybot._id };
}
const usageRows = (t: T) => t.run((ctx) => ctx.db.query("usage").collect());
const replyOf = (t: T, id: Id<"chatMessages">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const setImages = async (as: As, changes: { imageModel?: string; imageBudgetUsd?: number }) => {
	const settings = (await as.query(api.workspace.settings))!;
	await as.mutation(api.workspace.updateSettings, { name: settings.name, expectedVersion: settings.version, ...changes });
};
/** Posts a picture in `chatId` as `as`, and returns its file id. */
async function postPicture(as: As, chatId: Id<"chats">) {
	const response = await as.fetch(`/files/upload?${new URLSearchParams({ name: "roof.png", workspaceId: await workspaceOf(as) })}`, { method: "POST", body: picture });
	const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
	const messageId = await as.mutation(api.messages.send, { chatId, text: "", mentions: noMentions, attachments: [storageId] });
	return `${messageId}/0`;
}

describe("images.generate", () => {
	it("makes a picture with Nano Banana by default, attaches it to the reply and records its cost for the person and agent", async () => {
		const { t, owner } = await ownerAndMember();
		const { turnId, replyId, agentId } = await turnOf(t, owner);
		const result = await t.action(internal.imageGen.generateFor, { turnId, prompt: "A roofer's logo", aspectRatio: "16:9" });
		expect(result).toEqual({ attached: [{ id: `${replyId}/0`, name: "picture.png" }], model: defaultImageModel });
		expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
			model: defaultImageModel,
			messages: [{ role: "user", content: [{ type: "text", text: "A roofer's logo" }] }],
			providerOptions: { google: { imageConfig: { aspectRatio: "16:9" } } },
		}));
		expect(generateImage).not.toHaveBeenCalled();
		expect((await replyOf(t, replyId)).attachments).toEqual([expect.objectContaining({ name: "picture.png", type: "image/png", width: 8, height: 6 })]);
		expect(await usageRows(t)).toEqual([
			expect.objectContaining({ kind: "image", model: defaultImageModel, costUsd: 0.04, userId: owner.userId, agentId, month: usageMonth(Date.now()) }),
		]);
	});

	it("runs image models with generateImage, edits a picture from the chat, and falls back to the listed price", async () => {
		const { t, owner } = await ownerAndMember();
		await setImages(owner, { imageModel: "bfl/flux-3-image" });
		const edit = await postPicture(owner, (await generalOf(owner))._id);
		const { turnId } = await turnOf(t, owner);
		expect(await t.action(internal.imageGen.generateFor, { turnId, prompt: "Make the roof red", editFiles: [edit] })).toMatchObject({ model: "bfl/flux-3-image" });
		expect(generateImage).toHaveBeenCalledWith({ model: "bfl/flux-3-image", prompt: { images: [picture], text: "Make the roof red" } });
		expect(generateText).not.toHaveBeenCalled();
		// The gateway reported no cost: FLUX 3's listed $0.048 a picture counts instead.
		expect((await usageRows(t))[0]).toMatchObject({ kind: "image", model: "bfl/flux-3-image", costUsd: 0.048 });
	});

	it("passes edit pictures to multimodal models as image parts", async () => {
		const { t, owner } = await ownerAndMember();
		const edit = await postPicture(owner, (await generalOf(owner))._id);
		const { turnId } = await turnOf(t, owner);
		await t.action(internal.imageGen.generateFor, { turnId, prompt: "Add a hat", editFiles: [edit] });
		expect(generateText.mock.calls[0]![0].messages[0].content).toEqual([{ type: "file", mediaType: "image/png", data: picture }, { type: "text", text: "Add a hat" }]);
	});

	it("refuses once this month's image spend reaches the budget, and when the budget is 0, without calling a model", async () => {
		const { t, owner } = await ownerAndMember();
		const workspaceId = await workspaceOf(owner);
		await t.run((ctx) => ctx.db.insert("usage", { workspaceId, month: usageMonth(Date.now()), kind: "image", model: defaultImageModel, costUsd: 20 }));
		const { turnId } = await turnOf(t, owner);
		const month = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
		expect(await t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" })).toEqual({
			error: expect.stringContaining(`image budget for ${month} ($20.00) is used up`),
		});
		await setImages(owner, { imageBudgetUsd: 25 });
		expect(await t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" })).toHaveProperty("attached");
		await setImages(owner, { imageBudgetUsd: 0 });
		expect(await t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" })).toEqual({ error: expect.stringContaining("turned off") });
		expect(generateText).toHaveBeenCalledTimes(1);
	});

	it("holds a picture's cost while it's made, so parallel calls can't spend past the budget by more than one picture", async () => {
		const { t, owner } = await ownerAndMember();
		const workspaceId = await workspaceOf(owner);
		await t.run((ctx) => ctx.db.insert("usage", { workspaceId, month: usageMonth(Date.now()), kind: "image", model: defaultImageModel, costUsd: 19.99 }));
		const { turnId } = await turnOf(t, owner);
		const results = await Promise.all([1, 2, 3, 4, 5].map(() => t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" })));
		expect(results.filter((r) => "attached" in r)).toHaveLength(1);
		expect(results.filter((r) => "error" in r)).toEqual(Array(4).fill({ error: expect.stringContaining("is used up") }));
		expect(generateText).toHaveBeenCalledTimes(1);
		expect(await t.run((ctx) => ctx.db.query("imageHolds").collect())).toEqual([]);
	});

	it("frees a hold when the call fails, and after a while if it never settles", async () => {
		const { t, owner } = await ownerAndMember();
		await setImages(owner, { imageBudgetUsd: 0.03 });
		const { turnId } = await turnOf(t, owner);
		generateText.mockRejectedValueOnce(new Error("Gateway down"));
		await expect(t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" })).rejects.toThrow("Gateway down");
		expect(await t.run((ctx) => ctx.db.query("imageHolds").collect())).toEqual([]);
		expect(await usageRows(t)).toEqual([]);
		// A call that crashed mid-way: its hold (Nano Banana's $0.0336 listed price) blocks the rest of the budget...
		const ready = await t.mutation(internal.imageGen.prepareFor, { turnId, editFiles: [] });
		if ("error" in ready) throw new Error(ready.error);
		expect(await t.run((ctx) => ctx.db.get(ready.holdId))).toMatchObject({ costUsd: 0.0336 });
		expect(await t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" })).toEqual({ error: expect.stringContaining("is used up") });
		// ...until its release, scheduled when it was made, runs.
		const release = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).find((f) => f.name.includes("release") && f.args[0].holdId === ready.holdId);
		expect(release!.scheduledTime - Date.now()).toBeGreaterThan(10 * 60_000);
		await t.mutation(internal.imageGen.release, { holdId: ready.holdId });
		expect(await t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" })).toHaveProperty("attached");
	});

	it("records a cost for every picture: the listed price, else a conservative default", async () => {
		const { t, owner } = await ownerAndMember();
		await setImages(owner, { imageModel: "openai/gpt-image-2" });
		const { turnId } = await turnOf(t, owner);
		await t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" });
		expect((await usageRows(t))[0]).toMatchObject({ model: "openai/gpt-image-2", costUsd: 0.007 });
		// A model with no listed price (the catalog had none for it), and no cost from the gateway.
		await t.run(async (ctx) => {
			await ctx.db.insert("modelCatalog", { models: [], imageModels: [{ id: "acme/painter", name: "Painter", provider: "acme" }], fetchedAt: Date.now() });
		});
		await setImages(owner, { imageModel: "acme/painter" });
		await t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" });
		expect((await usageRows(t)).find((r) => r.model === "acme/painter")).toMatchObject({ costUsd: IMAGE_PRICE_UNKNOWN_USD });
	});

	it("adds what pictures cost to the chat's running cost and the reply's stats, counted once in Usage", async () => {
		const { t, owner } = await ownerAndMember();
		const { turnId, replyId } = await turnOf(t, owner);
		await t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" });
		const usage = { model: "openai/gpt-6-luna", steps: 1, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, contextTokens: 15, costUsd: 0.01, durationMs: 100 };
		await t.mutation(internal.turns.finishReply, { turnId, usage });
		expect((await replyOf(t, replyId)).stats).toMatchObject({ costUsd: 0.01, imageCostUsd: 0.04, conversationCostUsd: 0.05 });
		const generalId = (await generalOf(owner))._id;
		expect((await t.run((ctx) => ctx.db.get(generalId)))!.costUsd).toBeCloseTo(0.05);
		const rows = await usageRows(t);
		expect(rows.map((r) => [r.kind, r.costUsd]).sort()).toEqual([["chat", 0.01], ["image", 0.04]]);
	});

	it("edits only pictures the person can see", async () => {
		const { t, owner, member } = await ownerAndMember();
		const secret = await owner.mutation(api.chats.createChannel, { name: "leadership", private: true });
		const hidden = await postPicture(owner, secret);
		const { turnId } = await turnOf(t, member);
		expect(await t.action(internal.imageGen.generateFor, { turnId, prompt: "Edit", editFiles: [hidden] })).toEqual({ error: `No file "${hidden}" in a chat you can see.` });
		expect(await t.action(internal.imageGen.generateFor, { turnId, prompt: "Edit", editFiles: ["nope/0"] })).toHaveProperty("error");
		expect(generateText).not.toHaveBeenCalled();
	});

	it("keeps only real pictures from the model, and still records what was paid", async () => {
		const { t, owner } = await ownerAndMember();
		const { turnId, replyId } = await turnOf(t, owner);
		generateText.mockResolvedValue({ files: [{ mediaType: "image/png", uint8Array: new TextEncoder().encode("<svg/>") }], providerMetadata: { gateway: { cost: "0.03" } } });
		expect(await t.action(internal.imageGen.generateFor, { turnId, prompt: "A logo" })).toEqual({ error: expect.stringContaining("made no picture") });
		expect((await replyOf(t, replyId)).attachments ?? []).toEqual([]);
		expect((await usageRows(t))[0]).toMatchObject({ costUsd: 0.03 });
	});
});

describe("picture settings", () => {
	it("defaults to Nano Banana and $20, and only owners change them, to listed models and sane budgets", async () => {
		const { owner, member } = await ownerAndMember();
		expect(await owner.query(api.workspace.settings)).toMatchObject({ imageModel: defaultImageModel, imageBudgetUsd: 20, imageSpentUsd: 0 });
		expect((await member.query(api.workspace.settings))!.imageSpentUsd).toBeNull();
		await expect(setImages(member, { imageBudgetUsd: 50 })).rejects.toThrow();
		await expect(setImages(owner, { imageModel: "made/up" })).rejects.toThrow("picture model");
		await expect(setImages(owner, { imageBudgetUsd: -1 })).rejects.toThrow("image budget");
		await setImages(owner, { imageModel: "openai/gpt-image-2", imageBudgetUsd: 12.345 });
		expect(await owner.query(api.workspace.settings)).toMatchObject({ imageModel: "openai/gpt-image-2", imageBudgetUsd: 12.35 });
	});

	it("are read and changed by agents through workspace_settings, as owners", async () => {
		const { t, owner } = await ownerAndMember();
		const { turnId } = await turnOf(t, owner);
		const got = (await t.mutation(internal.manageTools.runFor, { turnId, tool: "workspace.settings", input: { request: { action: "get" } } })) as Record<string, unknown>;
		expect(got).toMatchObject({ imageModel: defaultImageModel, imageBudgetUsd: 20, imageModels: expect.arrayContaining([defaultImageModel]) });
		await t.mutation(internal.manageTools.runFor, { turnId, tool: "workspace.settings", input: { request: { action: "update", expectedVersion: got.version, imageBudgetUsd: 5 } } });
		expect((await owner.query(api.workspace.settings))!.imageBudgetUsd).toBe(5);
	});
});
