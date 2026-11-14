import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { ownerAndMember, agentsOf, agentTurn, generalOf } from "./helpers";
import { persistConnectorContent } from "../convex/connectorArtifacts";
import { pngOf } from "../../core/test/files";

afterEach(() => vi.useRealTimers());
describe("connector media", () => {
	it("stores media outside tool logs and restricts it to its actor and current chat access", async () => {
		vi.useFakeTimers();
		const { t, owner, member } = await ownerAndMember();
		const { companybot } = await agentsOf(member);
		const chat = await generalOf(member);
		const turnId = await agentTurn(t, member, chat._id, companybot._id);
		const parts = await t.run(ctx => persistConnectorContent(ctx, turnId, [
			{ type: "image", mimeType: "image/png", data: btoa(String.fromCharCode(...pngOf(4, 4))) },
			{ type: "audio", mimeType: "audio/wav", data: btoa("RIFF0000WAVE") },
			{ type: "resource", resource: { uri: "https://evil.example/markup", mimeType: "text/html", blob: btoa("<script>bad()</script>") } },
		], "c1"));
		expect(JSON.stringify(parts)).not.toContain("base64");
		expect(parts.every(p => "artifactId" in p && !!p.artifactId)).toBe(true);
		await t.mutation(internal.activity.log, { turnId, callId: "c1", tool: "test.read", input: "{}", changes: false, output: "clipped text" });
		const activityId = await t.run(async ctx => (await ctx.db.query("agentActivity").first())!._id);
		const visible = await member.query(api.connectorArtifacts.forCall, { activityId });
		expect(visible.map(x => x.mimeType)).toEqual(["image/png", "audio/wav", "application/octet-stream"]);
		expect(visible.every(x => !!x.url)).toBe(true);
		expect(await owner.query(api.connectorArtifacts.forCall, { activityId })).toEqual([]);
		await t.run(ctx => ctx.db.patch(chat._id, { access: [] }));
		expect(await member.query(api.connectorArtifacts.forCall, { activityId })).toEqual([]);
	});
	it("does not fetch resource links or trust a server-supplied artifact URL", async () => {
		const { t } = await ownerAndMember();
		const result = await t.run(ctx => persistConnectorContent(ctx, "unused" as never, [{ type: "resource", resource: { uri: "http://127.0.0.1", text: "embedded" }, url: "http://127.0.0.1", artifactId: "forged" }, { type: "resource_link", name: "private", uri: "http://127.0.0.1" }], "c"));
		expect(result).toEqual([{ type: "resource", resource: { uri: "http://127.0.0.1", text: "embedded" } }, { type: "resource_link", name: "private", uri: "http://127.0.0.1" }]);
		expect(await t.run(ctx => ctx.db.query("connectorArtifacts").collect())).toEqual([]);
	});
});
