import { describe, expect, it } from "vitest";
import { welcomeText } from "./onboarding";

describe("welcomeText", () => {
	it("asks a new workspace's owner about the company in one open message, with @mention", () => {
		const text = welcomeText("new_workspace", { agent: "Companybot", name: "Ada", memory: true });
		expect(text).toMatch(/^Hi Ada, I'm Companybot\./);
		expect(text).toContain("only answer messages that @mention me");
		expect(text).toContain("I'll save it to team memory");
	});

	it("asks someone who joined about themselves, and promises no memory when it's off", () => {
		const text = welcomeText("joined", { agent: "Companybot", name: null, memory: false });
		expect(text).toMatch(/^Welcome! I'm Companybot\./);
		expect(text).toContain("Tell me your role and what you're working on.");
		expect(text).not.toContain("remember");
	});
});
