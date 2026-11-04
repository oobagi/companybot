import { describe, expect, it } from "vitest";
import { TOKEN_TAG, rehypeTokens, splitTokens } from "./tokens";

const tokens = {
	people: [
		{ type: "user" as const, id: "u1" as never, name: "Ada", image: null },
		{ type: "agent" as const, id: "a1" as never, name: "Scout", image: null },
		{ type: "agent" as const, id: "a2" as never, name: "Scout Pro", image: null },
	],
	channels: [{ name: "sales", id: "c1" as never }],
	skills: [{ id: "s1", name: "Proposal", description: "" }],
};
const kinds = (text: string) => splitTokens(text, tokens).map((p) => (typeof p === "string" ? p : `[${p.kind}:${p.text}]`));

describe("splitTokens", () => {
	it("finds each kind, longest name first", () => {
		expect(kinds("@Scout Pro and @Ada, see #sales for /Proposal")).toEqual(["[person:@Scout Pro]", " and ", "[person:@Ada]", ", see ", "[channel:#sales]", " for ", "[skill:/Proposal]"]);
	});

	it("matches any case and only at a word's start", () => {
		expect(kinds("@ada")).toEqual(["[person:@ada]"]);
		expect(kinds("ada@Ada.co a/Proposal #sales-team @Adam")).toEqual(["ada@Ada.co a/Proposal #sales-team @Adam"]);
	});
});

describe("rehypeTokens", () => {
	type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };
	const text = (value: string): Node => ({ type: "text", value });
	const el = (tagName: string, ...children: Node[]): Node => ({ type: "element", tagName, children });
	const chips = (tree: Node): string[] =>
		tree.tagName === TOKEN_TAG ? [String(tree.properties?.dataToken)] : (tree.children ?? []).flatMap(chips);

	it("turns names in an agent's reply into chips, but not inside code or links", () => {
		const tree = el("root", el("p", text("Ask "), el("strong", text("@ada")), text(" in #sales")), el("code", text("@Ada")), el("a", text("#sales")));
		rehypeTokens(tokens)(tree);
		expect(chips(tree)).toEqual(["@ada", "#sales"]);
	});
});
