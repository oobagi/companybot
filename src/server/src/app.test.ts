import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const as = (userId: string, init: RequestInit = {}) => ({
	...init,
	headers: { "x-user-id": userId, "content-type": "application/json", ...init.headers },
});

describe("server permissions", () => {
	it("rejects unknown users", async () => {
		const res = await createApp().request("/agents");
		expect(res.status).toBe(401);
	});

	it("shows members fewer Companybot tools than owners", async () => {
		const app = createApp();
		const visibleTools = async (user: string) => {
			const agents = await (await app.request("/agents", as(user))).json();
			return agents
				.find((a: { id: string }) => a.id === "companybot")
				.tools.filter((t: { visible: boolean }) => t.visible)
				.map((t: { id: string }) => t.id);
		};
		expect(await visibleTools("jaden")).toContain("memory.remember_for_team");
		expect(await visibleTools("teammate")).not.toContain("memory.remember_for_team");
	});

	it("blocks members from workspace memories and plugin installs", async () => {
		const app = createApp();
		const post = (path: string, body?: unknown) =>
			app.request(path, as("teammate", { method: "POST", body: JSON.stringify(body ?? {}) }));

		expect((await post("/memory", { scope: "workspace", content: "x" })).status).toBe(403);
		expect((await post("/memory", { scope: "personal", content: "x" })).status).toBe(201);
		expect((await post("/plugins/clock/uninstall")).status).toBe(403);
	});
});
