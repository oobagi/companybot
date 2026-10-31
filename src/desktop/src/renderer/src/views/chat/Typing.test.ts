import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TypingLine, statusLine } from "./Typing";

const typing = vi.hoisted(() => ({ list: undefined as unknown }));
vi.mock("../../convex", () => ({ useMutation: () => vi.fn(), useQuery: () => typing.list }));

const agent = (name: string, step: string | null) => ({ id: name, name, step });
const ada = { id: "u1", name: "Ada", at: Date.now() };
const render = (list: { people: (typeof ada)[]; agents: ReturnType<typeof agent>[] }) => {
	typing.list = list;
	return renderToStaticMarkup(createElement(TypingLine, { chatId: "c1" as never }));
};

describe("the line under the composer", () => {
	it("shows one agent's step as it changes, and types like a person while it writes", () => {
		expect(render({ people: [], agents: [agent("Companybot", "Searching records for Acme…")] })).toBe("Companybot: Searching records for Acme…");
		expect(render({ people: [], agents: [agent("Companybot", "Thinking…")] })).toBe("Companybot: Thinking…");
		expect(render({ people: [], agents: [agent("Companybot", null)] })).toBe("Companybot is typing…");
		expect(render({ people: [], agents: [] })).toBe("");
	});

	it("keeps people typing in the same line", () => {
		expect(render({ people: [ada], agents: [agent("Companybot", "Thinking…")] })).toBe("Companybot: Thinking… · Ada is typing…");
		expect(render({ people: [ada], agents: [agent("Companybot", null)] })).toBe("Companybot and Ada are typing…");
	});

	it("counts several agents, listing each one's step on hover", () => {
		const html = render({ people: [ada], agents: [agent("Companybot", "Thinking…"), agent("Scribe", null)] });
		expect(html).toContain("2 agents working</button> · Ada is typing…");
		expect(statusLine([agent("Companybot", "Thinking…"), agent("Scribe", "Reading #sales…")], [])).toEqual({ working: "2 agents working", typing: undefined });
	});
});
