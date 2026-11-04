import { expect, it } from "vitest";
import { welcomeText } from "./onboarding";

it("promises to remember only when memory is on", () => {
	expect(welcomeText("new_workspace", { agent: "Companybot", name: "Ada", memory: true })).toContain("save it to team memory");
	expect(welcomeText("joined", { agent: "Companybot", name: null, memory: false })).not.toMatch(/remember|memory/);
});
