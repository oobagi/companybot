import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "./data";
import { LinkPreviews } from "./LinkPreviews";

vi.mock("../../convex", () => ({ useMutation: () => vi.fn() }));

const card = { url: "https://news.example.com/story", title: "Big story", description: "What happened.", siteName: "The Daily", imageUrl: "https://x.convex.cloud/api/storage/abc" };
const render = (mine: boolean, cards: Record<string, unknown>[] = [card]) =>
	renderToStaticMarkup(createElement(LinkPreviews, { message: { _id: "m1", mine, linkPreviews: cards } as unknown as Message, onError: () => {} }));

describe("link preview cards", () => {
	it("show the site, title, text and our copy of the picture, and open the page outside the app", () => {
		const html = render(false);
		expect(html).toContain('href="https://news.example.com/story"');
		expect(html).toContain('target="_blank"');
		expect(html).toMatch(/The Daily.*Big story.*What happened\./);
		expect(html).toContain('src="https://x.convex.cloud/api/storage/abc"');
	});

	it("leave out what the page didn't give, and the picture when there's none", () => {
		const html = render(false, [{ ...card, siteName: null, description: null, imageUrl: null }]);
		expect(html).toContain("Big story");
		expect(html).not.toContain("<img");
	});

	it("offer the × only to the sender", () => {
		expect(render(true)).toContain("Hide the preview of Big story");
		expect(render(false)).not.toContain("Hide the preview");
	});
});
