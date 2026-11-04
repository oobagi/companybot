import { describe, expect, it, vi } from "vitest";
import { platformGuide } from "./guide";
import { type ImageStore, imageBudgetError, imageTools } from "./image-tools";
import { toolRisk } from "./action-rules";
import { ctx, owner } from "../test/helpers";

const tool = imageTools.find((t) => t.id === "images.generate")!;

describe("images.generate", () => {
	it("hands the request to the backend and gives the model a receipt, never the picture", async () => {
		const generate = vi.fn<ImageStore["generate"]>().mockResolvedValue({ attached: [{ id: "m1/0", name: "picture.png" }], model: "google/x" });
		const output = await tool.execute({ prompt: "A logo", aspectRatio: "1:1" }, { ...ctx(owner), images: { generate } });
		expect(generate).toHaveBeenCalledWith({ prompt: "A logo", aspectRatio: "1:1" });
		const receipt = (await tool.toModelOutput!({ toolCallId: "1", input: {}, output } as never)) as { type: string; value: string };
		expect(receipt).toEqual({ type: "text", value: expect.stringContaining("Attached to your reply: picture.png (m1/0)") });
		expect(tool.label!({ prompt: "x" }, output)).toBe("Made a picture");
		expect(tool.label!({ prompt: "x", editFiles: ["m1/0"] })).toBe("Edit a picture");
		const refused = (await tool.toModelOutput!({ toolCallId: "1", input: {}, output: { error: "Budget used up." } } as never)) as { value: string };
		expect(refused.value).toBe("Budget used up.");
	});

	it("spends money inside the workspace: asks only in runs following someone else's words", () => {
		expect(toolRisk(tool)).toBe("inside");
	});

	it("says why a budget stops pictures: off at 0, used up at the budget", () => {
		expect(imageBudgetError(0, 0, "2026-10")).toMatch("turned off");
		expect(imageBudgetError(20, 20, "2026-10")).toMatch("image budget for October 2026 ($20.00) is used up");
		expect(imageBudgetError(20, 19.99, "2026-10")).toBeNull();
	});

	it("is in the guide only when granted", () => {
		expect(platformGuide({ tools: ["images.generate"] })).toContain("images_generate");
		expect(platformGuide({ tools: ["chat.*"] })).not.toContain("images_generate");
	});
});
