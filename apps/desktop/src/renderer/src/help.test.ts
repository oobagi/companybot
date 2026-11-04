import { helpPages } from "@companybot/core/help";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Help pages tell people where each setting lives, so a new settings tab or screen must be written
// up. The screens read `window` on import, so they load after a stub.
let settingsTabs: readonly { id: string; label: string }[];
let sections: string[];

beforeAll(async () => {
	vi.stubGlobal("window", { location: { hash: "" }, addEventListener() {}, removeEventListener() {} });
	settingsTabs = (await import("./views/Settings")).settingsTabs;
	sections = [...(await import("./App")).views];
});

const docs = helpPages.map((p) => p.text).join("\n");

describe("help pages", () => {
	it("link every settings tab (#/settings/<tab>)", () => {
		const missing = settingsTabs.filter((t) => !docs.includes(`(#/settings/${t.id})`));
		expect(missing.map((t) => t.id), `Settings tab(s) with no help link. Add [${missing[0]?.label}](#/settings/${missing[0]?.id}) to its page in src/core/src/help/ (settings.ts lists every tab), and see wiki/extending.md → Help.`).toEqual([]);
	});

	it("link only settings tabs that exist", () => {
		const ids = new Set(settingsTabs.map((t) => t.id));
		const unknown = [...docs.matchAll(/#\/settings\/([a-z-]+)/g)].map((m) => m[1]!).filter((id) => !ids.has(id));
		expect(unknown, "Help links a settings tab that doesn't exist. Fix the link in src/core/src/help/.").toEqual([]);
	});

	it("mention every top-level screen (#/chat, #/pages, #/records, #/settings)", () => {
		const missing = sections.filter((s) => !docs.includes(`#/${s}`));
		expect(missing, `Screen(s) with no help page mention. Document #/${missing[0]} in the matching page in src/core/src/help/ (overview.ts lists them), and see wiki/extending.md → Help.`).toEqual([]);
	});
});
