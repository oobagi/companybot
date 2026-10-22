import { describe, expect, it } from "vitest";
import { buildToolSet, describeToolAccess } from "./agents";
import { builtinPlugins, companybot, scribe } from "./builtins";
import { InMemoryMemoryStore } from "./memory";
import { PluginRegistry } from "./plugins";
import type { Actor } from "./types";

const owner: Actor = { userId: "owner", role: "owner" };
const member: Actor = { userId: "member", role: "member" };
const other: Actor = { userId: "other", role: "member" };

const registry = () => new PluginRegistry(builtinPlugins, ["memory", "clock"]);
const visible = (access: ReturnType<typeof describeToolAccess>) => access.filter((a) => a.visible).map((a) => a.id);

describe("tool visibility", () => {
	it("gives owners every tool the agent grants", () => {
		expect(visible(describeToolAccess(companybot, owner, registry()))).toEqual(companybot.tools);
	});

	it("hides owner-only tools from members", () => {
		const access = describeToolAccess(companybot, member, registry());
		expect(access.find((a) => a.id === "memory.remember_for_team")).toEqual({
			id: "memory.remember_for_team",
			visible: false,
			reason: "role",
		});
	});

	it("limits an agent to the tools it was granted", () => {
		expect(visible(describeToolAccess(scribe, owner, registry()))).toEqual(["memory.search"]);
	});

	it("hides tools from uninstalled plugins", () => {
		const r = registry();
		r.uninstall("clock");
		expect(describeToolAccess(companybot, owner, r).find((a) => a.id === "clock.now")).toMatchObject({
			visible: false,
			reason: "not_installed",
		});
	});

	it("only sends visible tools to the model", () => {
		const tools = buildToolSet(companybot, { actor: member, agentId: "companybot", memory: new InMemoryMemoryStore() }, registry());
		expect(Object.keys(tools)).toEqual(["memory_search", "memory_remember", "clock_now"]);
	});
});

describe("memory permissions", () => {
	it("lets members manage only their personal memories", async () => {
		const store = new InMemoryMemoryStore();
		const team = await store.create(owner, { scope: "workspace", content: "We close at 5pm." });
		const mine = await store.create(member, { scope: "personal", content: "I prefer mornings." });

		await expect(store.create(member, { scope: "workspace", content: "x" })).rejects.toThrow("Only owners");
		await expect(store.update(member, team.id, "x")).rejects.toThrow("can't edit");
		await expect(store.update(member, mine.id, "I prefer afternoons.")).resolves.toMatchObject({
			content: "I prefer afternoons.",
		});
	});

	it("keeps personal memories private from other members but not owners", async () => {
		const store = new InMemoryMemoryStore();
		const mine = await store.create(member, { scope: "personal", content: "secret" });

		expect(await store.list(other)).toEqual([]);
		await expect(store.update(other, mine.id, "x")).rejects.toThrow("not found");
		expect((await store.list(owner)).map((m) => m.id)).toEqual([mine.id]);
		await expect(store.update(owner, mine.id, "edited by owner")).resolves.toBeTruthy();
	});
});
