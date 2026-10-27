import { asSchema } from "ai";
import { builtinTools } from "@companybot/core";
import { describe, expect, it } from "vitest";
import { parity } from "../convex/parity";
import { modules } from "./helpers";

describe("the parity registry", () => {
	it("decides every exported public mutation, including aliases and editor sync", async () => {
		const mutations: string[] = [];
		for (const [path, load] of Object.entries(modules)) {
			if (path.includes("/_generated/") || path.endsWith(".config.ts")) continue;
			const exports = (await load()) as Record<string, { isMutation?: boolean; isPublic?: boolean }>;
			for (const [name, value] of Object.entries(exports)) {
				if (value?.isMutation && value?.isPublic) mutations.push(`${path.split("/").pop()!.replace(/\.ts$/, "")}.${name}`);
			}
		}
		expect(Object.keys(parity).sort()).toEqual(mutations.sort());
		for (const [name, rule] of Object.entries(parity)) {
			expect(rule.humanOnly ?? "", name).not.toMatch(/pending|deferred|part [12]/i);
			expect(!!rule.agent?.length || !!rule.humanOnly?.trim(), name).toBe(true);
			for (const action of rule.agent ?? []) {
				const [id, verb] = action.split(":");
				const tool = builtinTools.find((t) => t.id === id);
				expect(tool, `${name}: ${id}`).toBeDefined();
				if (verb) {
					const schema = await asSchema(tool!.input).jsonSchema;
					expect(JSON.stringify(schema), action).toContain(`"const":"${verb}"`);
				}
			}
		}
	});
});
